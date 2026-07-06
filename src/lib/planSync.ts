// Single source of truth for "make sure the user has weeks of plan ahead."
// Used by Home (auto-regen on focus), the gap modal (reset), and the
// Training Days setting (regen after change).
//
// Storage model (option A): one weekly_plans row per 7-day window. A fully
// healthy user has up to HORIZON_WEEKS rows with week_start at today, +7,
// +14, +21. ensureCurrentWeekPlan is idempotent — every call only generates
// the missing weeks, never overwrites an existing row that's already up to
// version. force=true is the exception: it nukes the future and starts over.
//
// The GapModal "resume" catch-up flow (app/(tabs)/home.tsx) regenerates its
// own active+future horizon directly via buildCatchUpRows → generatePlan,
// stamped with CURRENT_PLAN_VERSION. Those rows therefore pass the
// version-based isSatisfied check on the next ensureCurrentWeekPlan call;
// no per-row marker is required. (Historical note: an earlier rigid-shift
// implementation used a `plan.shifted === true` marker — that handling was
// removed along with the rigid-shift code when the catch-up regen replaced
// it. See CLAUDE.md.)
//
// Why rows-of-7 instead of one row of 28:
// - The month-calendar and 30-day readers already match PlanDay.date within
//   [week_start, week_start+6]. Keeping that contract intact means readers
//   need zero changes.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { supabase } from './supabase';
import { syncWorkoutNotifications } from '../utils/notifications';
import {
  CURRENT_PLAN_VERSION,
  generatePlan,
  splitForDays,
  trainingDaysForSplit,
  type FitnessLevel,
  type Location,
  type PlanDay,
  type SplitId,
} from './planGeneration';
import { resolveBlockPosition } from './blockPosition';
import type { Goal } from './goalProfile';
import { deriveCanonicalWeek, weekRowMatchesCanonical } from '../utils/planCatchUp';
import { normalizeTrainingWeekdays, weekdaysToOffsets } from '../utils/trainingWeekdays';
import { gapResolvedThroughKey } from '../utils/planShift';

/** How far ahead we try to keep the user covered. 4 weeks ≈ a month — enough
 *  for the 30-day calendar to render real workouts on every day. */
const HORIZON_WEEKS = 4;

/** If the furthest-out covered date drops below today + this, we top up. Set
 *  below HORIZON*7 so an active user who burns through one week triggers a
 *  re-extension before they hit the cliff edge. */
const MIN_LOOKAHEAD_DAYS = 14;

/** Local-time YYYY-MM-DD for "today". */
function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/** weekStart + N days → YYYY-MM-DD (local). Null-safe: returns '' on bad input. */
function addDaysIso(weekStart: string | null | undefined, days: number): string {
  if (!weekStart) return '';
  const parts = weekStart.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return '';
  const d = new Date(parts[0], parts[1] - 1, parts[2] + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Integer weeks between two YYYY-MM-DD dates (b - a, floored, never negative).
 *  Used to map a week_start onto its mesocycle block index. */
function weeksBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || pa.some(isNaN) || pb.some(isNaN)) return 0;
  const da = new Date(pa[0], pa[1] - 1, pa[2]);
  const db = new Date(pb[0], pb[1] - 1, pb[2]);
  // Divide by 7 days in ms. Math.round protects against DST edges where the
  // raw diff is 7d ± 1h; we never want a one-hour shift to flip blockIndex.
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / 86400000 / 7));
}

/** Tolerant unwrapper for the plan JSON column. New writes are PlanDay[];
 *  some legacy onboarding writes wrapped it as { days: PlanDay[] }. */
function extractDays(plan: any): any[] | null {
  if (Array.isArray(plan?.days)) return plan.days;
  if (Array.isArray(plan)) return plan;
  return null;
}

/** AsyncStorage key for the offline read-fallback of the user's plan-shaping
 *  profile inputs. Supabase stays the source of truth / sync target; this is
 *  the last-known-good cache so split/days/level (and the regen + self-heal
 *  that depend on them) keep working offline — exact same model as
 *  plan:current and user:defaultLocation. */
const PROFILE_INPUTS_KEY = 'user:profileInputs';

/** The profile fields plan generation actually needs. Stored as a small
 *  JSON blob under PROFILE_INPUTS_KEY. Kept loosely typed (string) so callers
 *  can write without importing the SplitId/FitnessLevel unions; reads cast.
 *  `training_weekdays` is the user's calendar-weekday selection (0=Sun..6=Sat)
 *  from the onboarding/Profile picker — null means "no explicit pick", and
 *  the generator falls back to pickDefaultDayOffsets(training_days). */
export interface CachedProfileInputs {
  training_days: number | null;
  preferred_split: string | null;
  fitness_level: string | null;
  training_weekdays: number[] | null;
  /** The user's training goal (profiles.goal). Cached so the generator's
   *  lane (rep bands, rest, set climb) survives an offline regen — same
   *  model as the other plan-shaping fields. Null on legacy cache entries;
   *  the generator falls back to catalog values when goal is missing. */
  goal: string | null;
}

/** Read the cached profile inputs. Error-tolerant: any read/parse failure
 *  yields null (treated as "no cache") and never throws. */
export async function readCachedProfileInputs(): Promise<CachedProfileInputs | null> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_INPUTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedProfileInputs> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const wkRaw = (parsed as { training_weekdays?: unknown }).training_weekdays;
    const training_weekdays = Array.isArray(wkRaw)
      ? (wkRaw.filter(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6) as number[])
      : null;
    return {
      training_days: typeof parsed.training_days === 'number' ? parsed.training_days : null,
      preferred_split: typeof parsed.preferred_split === 'string' ? parsed.preferred_split : null,
      fitness_level: typeof parsed.fitness_level === 'string' ? parsed.fitness_level : null,
      training_weekdays: training_weekdays && training_weekdays.length > 0 ? training_weekdays : null,
      goal: typeof parsed.goal === 'string' ? parsed.goal : null,
    };
  } catch {
    return null;
  }
}

/** Merge-write the cached profile inputs. Only the fields present on `inputs`
 *  are changed; the rest are preserved from the existing cache. Fire-and-forget
 *  — any failure is swallowed so a cache write can never break the caller. */
export async function writeCachedProfileInputs(inputs: Partial<CachedProfileInputs>): Promise<void> {
  try {
    const existing = await readCachedProfileInputs();
    const merged: CachedProfileInputs = {
      training_days: inputs.training_days !== undefined ? inputs.training_days : (existing?.training_days ?? null),
      preferred_split: inputs.preferred_split !== undefined ? inputs.preferred_split : (existing?.preferred_split ?? null),
      fitness_level: inputs.fitness_level !== undefined ? inputs.fitness_level : (existing?.fitness_level ?? null),
      training_weekdays: inputs.training_weekdays !== undefined ? inputs.training_weekdays : (existing?.training_weekdays ?? null),
      goal: inputs.goal !== undefined ? inputs.goal : (existing?.goal ?? null),
    };
    await AsyncStorage.setItem(PROFILE_INPUTS_KEY, JSON.stringify(merged));
  } catch {
    // Cache write is best-effort — never let it break the caller.
  }
}

interface EnsureArgs {
  /** Force a fresh regen even if a plan exists. Deletes future weekly_plans
   *  rows (week_start >= today) and rebuilds the whole HORIZON_WEEKS horizon
   *  from today. Past rows are kept so streak/history reads still resolve. */
  force?: boolean;
}

/**
 * Make sure the user has plan rows covering today and roughly the next
 * HORIZON_WEEKS * 7 days. If anything is missing (or `force=true`), generate
 * the missing weeks from the user's profile + saved default location and
 * persist them as individual rows.
 *
 * Returns the PlanDay[] in effect for today, or null on failure / missing
 * profile config.
 */
export async function ensureCurrentWeekPlan({ force = false }: EnsureArgs = {}): Promise<PlanDay[] | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const today = todayIso();

    const { data: profile } = await supabase
      .from('profiles')
      .select('training_days, preferred_split, fitness_level, training_weekdays, goal')
      .eq('id', user.id)
      .maybeSingle();

    // Offline read-fallback for the plan-shaping inputs. Supabase is the
    // source of truth; this cache is consulted ONLY when the network read
    // gave nothing for a field (offline, or a transient miss) — same model as
    // plan:current. Resolution is per-field: prefer the network value, fall
    // back to last-known-good cache.
    const cachedInputs = await readCachedProfileInputs();
    const netTrainingDays = profile?.training_days as number | null | undefined;
    const netPreferredSplit = profile?.preferred_split as SplitId | null | undefined;
    const netFitnessLevel = profile?.fitness_level as FitnessLevel | null | undefined;

    // True when the network read actually returned usable inputs. Both the
    // backfill writes and the cache refresh are gated on this: offline, a
    // failed write stays fire-and-forget and we never clobber the cache with
    // an empty network read.
    const networkProvidedInputs =
      (netTrainingDays != null && netTrainingDays > 0) || !!netPreferredSplit;

    // Recover gracefully from partially-populated profiles. The historical
    // failure mode was: training_days nulled out (data migration, dashboard
    // edit, etc.) → ensureCurrentWeekPlan silently returns null → home shows
    // the "building your week" spinner forever. We only truly give up when
    // both training_days AND preferred_split are missing across network AND
    // cache.
    const rawTrainingDays =
      (netTrainingDays != null ? netTrainingDays : cachedInputs?.training_days) as number | null | undefined;
    const rawPreferredSplit =
      (netPreferredSplit ?? (cachedInputs?.preferred_split as SplitId | null | undefined)) as SplitId | null | undefined;

    let trainingDays: number;
    if (rawTrainingDays && rawTrainingDays > 0) {
      trainingDays = rawTrainingDays;
    } else if (rawPreferredSplit) {
      // Derive from the split so we don't brick the account. Persist it back
      // so the next read is clean — but ONLY when we actually reached the
      // network. Offline we use the derived value locally without attempting
      // a write that would just fail.
      trainingDays = trainingDaysForSplit(rawPreferredSplit);
      if (networkProvidedInputs) {
        const { error: backfillError } = await supabase
          .from('profiles')
          .update({ training_days: trainingDays })
          .eq('id', user.id);
        if (backfillError) {
          console.warn('[planSync] profiles training_days backfill failed', backfillError);
          Sentry.captureException(backfillError);
        }
      }
    } else {
      const msg = `[planSync] ensureCurrentWeekPlan bailing: missing training_days and preferred_split (user=${user.id})`;
      console.warn(msg);
      Sentry.captureMessage(msg, 'warning');
      return null;
    }

    const storedLoc = await AsyncStorage.getItem('user:defaultLocation');
    const location: Location = storedLoc === 'Home' ? 'home' : 'gym';
    const fitnessLevel = (netFitnessLevel ?? (cachedInputs?.fitness_level as FitnessLevel) ?? 'beginner') as FitnessLevel;

    // Goal drives per-exercise dose (reps / rest / sets) via goalProfile.
    // Resolution mirrors the other plan-shaping fields: network first,
    // offline cache fallback. Default to 'general' when the user has no
    // pick — the general lane is a PURE PASSTHROUGH (catalog values flow
    // through unchanged) so pre-goal / default accounts see exactly the
    // pre-goal engine's output. Only 'strength' and 'muscle' shape the
    // dose. This is intentional: a user who never asked for a change
    // should never silently see their programme rewritten.
    const netGoal = (profile as { goal?: unknown } | null | undefined)?.goal;
    const rawGoal = (typeof netGoal === 'string' ? netGoal : cachedInputs?.goal) as string | null | undefined;
    const goal: Goal =
      rawGoal === 'strength' || rawGoal === 'muscle' || rawGoal === 'general' ? rawGoal : 'general';
    // The cache stores the AUTHORITATIVE value from network/cache, not the
    // fallback — otherwise a user who never picked a goal would see the
    // cache silently upgrade to 'general' on first read, and the next
    // profile.goal write would appear to be a "change from general" in
    // any diff tooling. Cache null; generatePlan / prescribeLoad receive
    // the fallback 'general' from this function directly.
    const goalForCache: string | null =
      rawGoal === 'strength' || rawGoal === 'muscle' || rawGoal === 'general' ? rawGoal : null;

    // The user's EXPLICIT split drives generation now (it's a chosen value,
    // not a function of training_days). Fall back to the days-derived default
    // only when no pick exists. Threaded into deriveCanonicalWeek + generatePlan
    // below so a deliberate split/days mismatch (e.g. bro_split @ 2 days) both
    // generates and self-heals against the SAME split. The cached
    // preferred_split is the user's pick, so resolving from it offline is
    // correct — the explicit-split-never-overwritten semantics are unchanged.
    const split: SplitId = rawPreferredSplit ?? splitForDays(trainingDays);

    // training_weekdays — user's calendar-weekday picks (0=Sun..6=Sat).
    // Source of truth for WHICH calendar days the plan schedules sessions
    // on. Null when the user is on a legacy profile or an out-of-scope day
    // count (1, 2, 7) — the generator falls back to pickDefaultDayOffsets
    // in that case so nothing breaks. Resolution mirrors the other fields:
    // prefer the network value, fall back to the offline cache.
    const netTrainingWeekdays = normalizeTrainingWeekdays(
      (profile as { training_weekdays?: unknown } | null | undefined)?.training_weekdays,
    );
    const trainingWeekdays: number[] | null =
      netTrainingWeekdays ?? cachedInputs?.training_weekdays ?? null;

    // When training_weekdays is set it is authoritative for the day COUNT
    // too — the picker derives the count from the selection on write, so
    // any divergence between weekdays.length and training_days is a stale
    // value (e.g. a profile edit raced). Pin them so the bro_split rolling
    // math (i * trainingDays) and the per-week offsets agree by
    // construction; otherwise the heal could oscillate.
    if (trainingWeekdays && trainingWeekdays.length !== trainingDays) {
      trainingDays = trainingWeekdays.length;
    }

    // Refresh the last-known-good cache from a successful network read so the
    // next offline open has current inputs. Skipped when we resolved from
    // cache (offline) — nothing newer to persist. Awaited but error-tolerant;
    // it can never break generation.
    if (networkProvidedInputs) {
      await writeCachedProfileInputs({
        training_days: trainingDays,
        preferred_split: split,
        fitness_level: fitnessLevel,
        training_weekdays: trainingWeekdays,
        goal: goalForCache,
      });
    }

    if (force) {
      // Wipe the future before regenerating so the horizon is clean. Past
      // rows remain so streak/history reads still resolve historical
      // workouts. This is the reset path — the user picked "Reset to a
      // fresh week" at the GapModal, OR Training Days changed.
      //
      // Cutoff is today-6, NOT today. A row anchored at today-3 still
      // covers today through today+3 via its 7-day window; deleting
      // only week_start >= today would leave that row behind and the
      // newly-generated row anchored at today would silently overlap
      // it, mapping today..today+3 to TWO different workout types.
      // week_start + 6 >= today ⇔ week_start >= today - 6.
      const cutoff = addDaysIso(today, -6);
      const { error: deleteError } = await supabase
        .from('weekly_plans')
        .delete()
        .eq('user_id', user.id)
        .gte('week_start', cutoff);
      if (deleteError) {
        console.warn('[planSync] weekly_plans force-delete failed', deleteError);
        Sentry.captureException(deleteError);
      }
    }

    // ── Survey what's already covering today onward ──────────────────────
    // We need rows whose [week_start, week_start+6] window touches today or
    // later. A row anchored at today-6 still covers today, so we include
    // anything with week_start >= today-6.
    const surveyFrom = addDaysIso(today, -6);
    const { data: rowsRaw } = await supabase
      .from('weekly_plans')
      .select('plan, week_start, plan_version')
      .eq('user_id', user.id)
      .gte('week_start', surveyFrom)
      .order('week_start', { ascending: true });
    const futureRows = rowsRaw ?? [];

    // Row covering today (the active week).
    const coveringNow = futureRows.find(r => {
      const end = addDaysIso(r.week_start, 6);
      return r.week_start <= today && today <= end;
    }) ?? null;

    // Horizon anchor: the active week's week_start when one exists, else
    // today (a brand-new account or a fully-elapsed plan).
    const horizonAnchor = coveringNow?.week_start ?? today;

    // Existing future week_starts >= horizon, mapped to the generator version
    // that produced each one (legacy rows predate the column → treated as 0).
    const versionByStart = new Map<string, number>();
    for (const r of futureRows) {
      if (r.week_start >= horizonAnchor) {
        versionByStart.set(r.week_start, (r as any).plan_version ?? 0);
      }
    }

    // ── Mesocycle anchor: earliest existing plan week, fallback today ────
    // blockIndex = floor(weeksSince(anchor) / 4) keeps weeks 1–4 of every
    // block identical, then rotates at the boundary. Using the earliest
    // existing weekly_plans row as anchor means a returning user's block
    // boundaries don't shift when a top-up call lands; a brand-new user
    // anchors on today so their first 4 weeks are block 0. Hoisted above
    // the satisfaction check because the active-week self-heal below needs
    // the block math to derive the canonical week.
    const { data: anchorRow } = await supabase
      .from('weekly_plans')
      .select('week_start')
      .eq('user_id', user.id)
      .order('week_start', { ascending: true })
      .limit(1)
      .maybeSingle();
    const blockAnchor: string = anchorRow?.week_start ?? today;

    // ── True rotation position: completed sessions before the active week ─
    // The user's position in the split rotation is fully determined by how
    // many non-recovery sessions they have actually completed before the
    // active week began. "Before the week" (not all-time) keeps the value
    // stable across the week, so the heal below is idempotent: completing
    // today's session doesn't change the derivation for this week.
    const { count: completedBeforeRaw } = await supabase
      .from('workout_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('completed', true)
      .eq('is_recovery', false)
      .lt('planned_date', horizonAnchor);
    const completedBeforeWeek = completedBeforeRaw ?? 0;

    // ── Per-block completed session counts (earned-deload gate) ──────────
    // Fetch every completed non-recovery session's planned_date since the
    // block anchor, then bucket by block index (4 calendar weeks per block).
    // Only sessions in the block's WEEKS 1–3 window (weeks 0..2 into the
    // block) count toward "earned" — a session that happened to land in a
    // calendar wk4 doesn't retroactively earn its own deload. See
    // resolveBlockPosition + DELOAD_EARN_FLOOR.
    //
    // One fetch, one pass over the results, cheap map lookup at each
    // materialization site — no per-week query storm.
    const sessionsPerBlockIndex = new Map<number, number>();
    try {
      const { data: sessionRows } = await supabase
        .from('workout_sessions')
        .select('planned_date')
        .eq('user_id', user.id)
        .eq('completed', true)
        .eq('is_recovery', false)
        .gte('planned_date', blockAnchor);
      for (const row of sessionRows ?? []) {
        if (!row?.planned_date) continue;
        const weeksIn = weeksBetween(blockAnchor, row.planned_date);
        const bIndex = Math.floor(weeksIn / 4);
        const bWeek = (weeksIn % 4) + 1;
        // Only weeks 1–3 count toward earning the block's deload. A session
        // that happened to land in calendar wk4 was itself part of a
        // (possibly reset) deload week — it doesn't retroactively license
        // that same wk4 as earned.
        if (bWeek === 4) continue;
        sessionsPerBlockIndex.set(bIndex, (sessionsPerBlockIndex.get(bIndex) ?? 0) + 1);
      }
    } catch (err) {
      // Never break plan sync on the earned-deload count query; the helper
      // treats a missing/zero count as "unearned", which is the safe
      // default (resets rather than materializes a phantom deload).
      Sentry.captureException(err);
    }

    /** Resolve the calendar (blockIndex, blockWeek) position for a given
     *  week_start, applying the earned-deload gate. Single source of truth
     *  the loop below AND the cache refresh AND the self-heal all funnel
     *  through — they cannot disagree by construction. */
    const resolvePosition = (weekStart: string) => {
      const weeksFromAnchor = weeksBetween(blockAnchor, weekStart);
      const rawIndex = Math.floor(weeksFromAnchor / 4);
      return resolveBlockPosition({
        weeksFromAnchor,
        blockCompletedSessions: sessionsPerBlockIndex.get(rawIndex) ?? 0,
      });
    };

    // ── Active-week self-heal check ──────────────────────────────────────
    // The stored active row is a cache of the canonical generation, not a
    // source of truth. Compare it (dates + workout types only) against
    // generatePlan at the user's true position; a deviating row — collapsed,
    // wrong types, overlap artifact — is regenerated in the loop below
    // rather than trusted. This is what lets an already-corrupted account
    // converge to a correct plan on next open with no manual data deletion.
    //
    // Exception: when the GapModal resolution watermark covers this week
    // (resolvedThrough >= week_start), the user just pressed resume/skip and
    // the row was intentionally rewritten as a catch-up pack (back-to-back
    // days, advanced rotation). That row is NOT canonical-cadence shaped and
    // must survive until the week rolls over, so the heal defers to it.
    const resolvedThrough = await AsyncStorage.getItem(gapResolvedThroughKey(user.id));
    const activeRowValid = ((): boolean => {
      if (!coveringNow) return false;
      if (resolvedThrough && resolvedThrough >= horizonAnchor) return true;
      const stored = extractDays(coveringNow.plan) as PlanDay[] | null;
      if (!stored) return false;
      // planHistory only affects exercise selection, never dates/types, so
      // the comparison canonical can be derived without fetching history.
      // selectedDayOffsets MUST be derived from training_weekdays here so
      // the canonical comparison agrees with the per-week generation loop
      // below — both feed the SAME weekdays into the SAME helper. If we
      // skipped this for the heal, a user with Mon/Wed/Fri would see the
      // active row regenerated every focus (default offsets [0,2,4] would
      // place sessions on Sun/Tue/Thu instead, never matching the stored
      // weekday-correct row).
      const healOffsets = weekdaysToOffsets(trainingWeekdays, horizonAnchor);
      // Self-heal canonical must use the SAME earned-deload gate as the
      // materialization loop below — otherwise a corrected non-deload
      // active week would keep healing back into an unearned deload on
      // next open. resolvePosition applies the gate; the derived
      // canonical row matches what the loop would (re)generate.
      const healPos = resolvePosition(horizonAnchor);
      const canonical = deriveCanonicalWeek({
        weekStartIso: horizonAnchor,
        completedBeforeWeek,
        trainingDays,
        fitnessLevel,
        location,
        split,
        goal,
        blockIndex: healPos.blockIndex,
        blockWeek: healPos.blockWeek,
        selectedDayOffsets: healOffsets ?? undefined,
      });
      return weekRowMatchesCanonical(stored, canonical);
    })();

    // A wanted week is "satisfied" (no work needed) when a row exists for it
    // AND either:
    //   - it's the active week (index 0 in wantedStarts) and it passes the
    //     self-heal validation above (canonical for the user's true position,
    //     or protected by a fresh GapModal resume/skip watermark); or
    //   - its generator version is current.
    // A FUTURE row written by an outdated generator is deliberately NOT
    // satisfied, so it gets rebuilt with the current logic. This is what makes
    // a generation fix reach existing accounts without manual SQL or a rebuild.
    const isSatisfied = (ws: string, idx: number): boolean => {
      if (!versionByStart.has(ws)) return false;
      if (idx === 0) return activeRowValid;
      return (versionByStart.get(ws) ?? 0) >= CURRENT_PLAN_VERSION;
    };

    // Furthest covered end date across all surveyed rows.
    let maxCoveredEnd = '';
    for (const r of futureRows) {
      const e = addDaysIso(r.week_start, 6);
      if (e > maxCoveredEnd) maxCoveredEnd = e;
    }
    const minNeededFurthest = addDaysIso(today, MIN_LOOKAHEAD_DAYS - 1);

    // Wanted week_starts: HORIZON_WEEKS rows anchored on horizonAnchor.
    const wantedStarts: string[] = [];
    for (let w = 0; w < HORIZON_WEEKS; w++) {
      wantedStarts.push(addDaysIso(horizonAnchor, w * 7));
    }
    // Extend further if even the full horizon would leave us under the
    // lookahead threshold (defensive — shouldn't happen with current consts).
    while (true) {
      const last = wantedStarts[wantedStarts.length - 1];
      const lastEnd = addDaysIso(last, 6);
      if (lastEnd >= minNeededFurthest) break;
      wantedStarts.push(addDaysIso(last, 7));
    }

    const missingStarts = wantedStarts.filter((s, i) => !isSatisfied(s, i));

    if (missingStarts.length === 0) {
      // Everything is covered. Refresh the AsyncStorage cache from the
      // covering row and return so consumers (workout screen, dashboard) see
      // the latest persisted plan.
      if (coveringNow?.plan) {
        const days = extractDays(coveringNow.plan) as PlanDay[] | null;
        if (days) {
          await AsyncStorage.setItem(
            'plan:current',
            JSON.stringify({
              generatedAt: new Date().toISOString(),
              weekStart: coveringNow.week_start,
              blockWeek: resolvePosition(coveringNow.week_start).blockWeek,
              days,
            }),
          );
          void syncWorkoutNotifications();
          return days;
        }
      }
      return null;
    }

    // ── Variety history (last 4 weeks before horizonAnchor) ──────────────
    const { data: priorRows } = await supabase
      .from('weekly_plans')
      .select('plan')
      .eq('user_id', user.id)
      .lt('week_start', horizonAnchor)
      .order('week_start', { ascending: false })
      .limit(4);

    const planHistory = (priorRows ?? [])
      .map(row => {
        const days = extractDays(row.plan) ?? [];
        const names: string[] = [];
        for (const d of days) {
          if (Array.isArray(d?.exercises)) {
            for (const ex of d.exercises) if (ex?.name) names.push(ex.name);
          }
        }
        return { exercises: names };
      })
      .filter(h => h.exercises.length > 0);

    // ── Generate the missing weeks ───────────────────────────────────────
    // Iterate wantedStarts in order so dayIndexOffset (cycle phase) lines up
    // with each row's position in the horizon. Skip rows that already exist
    // so we never clobber a row a missed-handler shift may have rewritten.
    let regeneratedActiveDays: PlanDay[] | null = null;
    for (let i = 0; i < wantedStarts.length; i++) {
      const ws = wantedStarts[i];
      if (isSatisfied(ws, i)) continue;
      // Position resolved through the earned-deload gate. When the block's
      // weeks 1–3 weren't trained (sessionsPerBlockIndex[rawIndex] <
      // DELOAD_EARN_FLOOR), the calendar week-4 rolls to (rawIndex+1, 1)
      // instead of stamping a phantom deload. Weeks 1–3 pass through
      // unchanged, so a real trained block's deload still lands.
      const { blockIndex, blockWeek } = resolvePosition(ws);
      // Per-week offsets from the user's stored weekdays. Each row is its
      // own 7-day window anchored at `ws`, so the offset values depend on
      // ws's day-of-week — Mon/Wed/Fri lands at [1,3,5] from a Sunday
      // week_start but at [0,2,5] from a Wednesday week_start. null
      // (legacy / 1/2/7-day users) → generator falls back to
      // pickDefaultDayOffsets(trainingDays). The same helper drove the
      // self-heal canonical above, so by construction the row written here
      // matches what the heal would compute — no oscillation.
      const offsets = weekdaysToOffsets(trainingWeekdays, ws);
      const days = generatePlan({
        fitnessLevel,
        trainingDays,
        location,
        split,
        goal,
        planHistory,
        weeksAhead: 1,
        startDate: ws,
        // Rotation continues from the user's TRUE position: sessions
        // actually completed before the active week, plus trainingDays per
        // horizon week after it. Anchoring on completedBeforeWeek (instead
        // of the old position-0 assumption, i * trainingDays alone) is what
        // makes a regenerated active week resume at the user's next
        // canonical dayType — after 10 completed PPL sessions the next type
        // is pull, not a fresh push week.
        dayIndexOffset: completedBeforeWeek + i * trainingDays,
        // Same blockIndex across 4 consecutive weeks ⇒ identical lifts
        // (progressive-overload substrate). Rotates at the block boundary.
        blockIndex,
        blockWeek,
        selectedDayOffsets: offsets ?? undefined,
      });
      if (i === 0) regeneratedActiveDays = days;
      const { error: upsertError } = await supabase.from('weekly_plans').upsert(
        { user_id: user.id, week_start: ws, plan: days, plan_version: CURRENT_PLAN_VERSION },
        { onConflict: 'user_id,week_start' },
      );
      if (upsertError) {
        console.warn('[planSync] weekly_plans upsert failed', upsertError);
        Sentry.captureException(upsertError);
      }
    }

    // ── Refresh AsyncStorage cache with today's covering row ─────────────
    // Preference order: the week we just (re)generated — which includes the
    // self-heal rewrite of a corrupted row — then the stored covering row,
    // then a re-read.
    let cacheDays: PlanDay[] | null = null;
    let cacheWeekStart = horizonAnchor;
    if (regeneratedActiveDays) {
      cacheDays = regeneratedActiveDays;
      cacheWeekStart = horizonAnchor;
    } else if (coveringNow?.plan) {
      cacheDays = extractDays(coveringNow.plan) as PlanDay[] | null;
      cacheWeekStart = coveringNow.week_start;
    } else {
      // We just generated the row at horizonAnchor (== today path). Re-read.
      const { data: justGen } = await supabase
        .from('weekly_plans')
        .select('plan')
        .eq('user_id', user.id)
        .eq('week_start', horizonAnchor)
        .maybeSingle();
      cacheDays = justGen?.plan ? (extractDays(justGen.plan) as PlanDay[] | null) : null;
    }
    if (cacheDays) {
      await AsyncStorage.setItem(
        'plan:current',
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          weekStart: cacheWeekStart,
          blockWeek: resolvePosition(cacheWeekStart).blockWeek,
          days: cacheDays,
        }),
      );
      void syncWorkoutNotifications();
    }

    // preferred_split is the user's EXPLICIT choice — never silently overwrite
    // it from training_days (that would clobber a deliberate split/days
    // mismatch the moment the user edits their schedule). Only BACKFILL when
    // it's genuinely missing, so an account with no pick still gets a sensible
    // default persisted for the next read.
    // Guard on networkProvidedInputs so we don't attempt a write while
    // offline (it would just fail) — the backfill resumes on the next online
    // open. Fire-and-forget by construction.
    if (!rawPreferredSplit && networkProvidedInputs) {
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ preferred_split: split })
        .eq('id', user.id);
      if (profileError) {
        console.warn('[planSync] profiles preferred_split backfill failed', profileError);
        Sentry.captureException(profileError);
      }
    }

    return cacheDays;
  } catch (e) {
    console.warn('[planSync] ensureCurrentWeekPlan failed', e);
    Sentry.captureException(e);
    return null;
  }
}
