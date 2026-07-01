// Client wrapper for the coach-recap edge function + pure helpers that build
// the context and produce a deterministic fallback recap.
//
// Architecture:
//   1. buildCoachRecapContext(args)   — pure, takes the data already in scope
//      in app/workout.tsx (today's logs, lastWeights, exerciseHistory, energy,
//      streak, blockWeek, deload flag) and produces the rich CoachRecapContext
//      the edge function consumes.
//   2. requestCoachRecap(ctx)         — async network call. Never throws.
//      On any failure (error, timeout, missing key, empty body) returns
//      { kind: 'error' }.
//   3. buildFallbackRecap(ctx)        — pure, produces a templated recap using
//      the SAME salience hierarchy the AI prompt uses, so the popup ALWAYS
//      renders. The AI is the upgrade layer, not the only path.
//
// Salience hierarchy (highest first):
//   1. PR
//   2. Lift that progressed this block (today's weight beats prior on a logged lift)
//   3. Hit target effort (RIR 1 or 2 on at least one set)
//   4. Trained despite low energy (energy ≤ 2 and they logged anything)
//   5. Streak milestone (5/7/10/14/21/30/50/100)
//   6. Otherwise — one specific light observation
//
// Cold start (first-ever session or first time on every lift today) gets a
// distinct line — "first one logged, I'll track your progress from here" —
// instead of pretending to reflect on absent history.

import { supabase } from './supabase';

// ─── Public types ──────────────────────────────────────────────────────

export interface CoachRecapTodayLog {
  exercise_name: string;
  weight_kg: number | null; // null = bodyweight
  reps: string | number | null;
  rir: number | null;
}

export interface CoachRecapPerLiftRecent {
  weight_kg: number | null;
  rir: number | null;
  /** Days between this entry's logged_date and today (strictly > 0 — entries
   *  dated today are excluded; that's today's set, not a "prior session"). */
  days_ago: number;
}

export interface CoachRecapPerLiftTrend {
  name: string;
  /** Most recent 2–3 prior sessions for this lift, newest first. Empty
   *  array when the user has no prior history for the lift. */
  recent: CoachRecapPerLiftRecent[];
}

/** Context payload sent to the edge function and consumed by the fallback.
 *  Every field is what the model is allowed to reference; nothing else
 *  may be invented. */
export interface CoachRecapContext {
  today_logs: CoachRecapTodayLog[];
  /** Exercise names that hit a new 8-week best this session. */
  prs: string[];
  /** Today's pre-workout energy score (1–5). */
  energy_score: number;
  /** Consecutive-day streak as of today. */
  streak: number;
  /** In-block week (1–4) of today's mesocycle. Undefined when unknown. */
  block_week?: number;
  /** Short one-line summary vs the same lifts last session (the legacy field;
   *  kept for backwards-compatibility with the v1 recap prompt). */
  vs_last_session: string;
  /** Display label of today's workout (Push / Pull / Upper / etc.). Lets the
   *  fallback open with a specific "<Type> done — …" line instead of a
   *  generic acknowledgement. */
  workout_type?: string;
  /** Last 2–3 sessions of every lift the user trained today. Drives the
   *  "trajectory" continuity in the AI prompt and the "progressed this block"
   *  salience tier in the fallback. */
  per_lift_trend: CoachRecapPerLiftTrend[];
  /** True iff at least one logged set landed at RIR 1 or 2 — the
   *  autoregulator's target zone. */
  target_zone_hit: boolean;
  /** True iff today was a deload week (PlanDay.deload === true). The model
   *  uses this to NOT celebrate progression on a deload session. */
  deload: boolean;
  /** True iff energy was 1 or 2 AND the user still logged at least one set. */
  trained_despite_low_energy: boolean;
  /** True iff this is the user's first-ever session, or first time on every
   *  lift they trained today. The fallback and the model both produce a
   *  distinct "first one logged" line. */
  cold_start: boolean;
}

export type CoachRecapResult =
  | { kind: 'ok'; message: string }
  | { kind: 'error' };

/**
 * The single line every caller runs after `await requestCoachRecap(ctx)`:
 * use the AI message when we got one, otherwise compute the deterministic
 * fallback from the same context. Lifts the pattern out of finishWorkout so
 * the integration test ("appends on both AI-success and fallback paths")
 * can exercise it without a React harness.
 */
export function produceRecapMessage(
  result: CoachRecapResult,
  ctx: CoachRecapContext,
): string {
  return result.kind === 'ok' ? result.message : buildFallbackRecap(ctx);
}

// ─── Pure: context builder ─────────────────────────────────────────────

export interface BuildCoachRecapContextArgs {
  /** YYYY-MM-DD local. */
  todayStr: string;
  workoutType?: string;
  /** PlanDay.deload — true on the 4th week of every mesocycle block. */
  planDayDeload?: boolean;
  todayLogs: CoachRecapTodayLog[];
  prs: string[];
  energyScore: number;
  streak: number;
  blockWeek?: number;
  /** Latest log per exercise (workout.tsx's lastWeights). */
  lastWeights: Record<string, { weight: number; date: string; rir: number | null }>;
  /** Up to ~6 most recent logs per exercise, newest first (workout.tsx's
   *  exerciseHistory). May or may not carry RIR — both shapes are tolerated. */
  exerciseHistory: Record<string, Array<{ weight_kg: number; date: string; rir?: number | null }>>;
}

/** Days between two YYYY-MM-DD strings (b - a, rounded). Negative inputs
 *  clamp to 0 so a future-dated history row doesn't surface as -1. */
function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || pa.some(isNaN) || pb.some(isNaN)) return 0;
  const da = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
  const db = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
  return Math.max(0, Math.round((db - da) / 86400000));
}

export function buildCoachRecapContext(args: BuildCoachRecapContextArgs): CoachRecapContext {
  const {
    todayStr,
    workoutType,
    planDayDeload,
    todayLogs,
    prs,
    energyScore,
    streak,
    blockWeek,
    lastWeights,
    exerciseHistory,
  } = args;

  // vs_last_session — legacy compact one-liner. Picks the heaviest delta on
  // the lifts the user touched today vs lastWeights. Same logic the original
  // inline build used, lifted here so the helper owns every field.
  const vsLastSession = (() => {
    let pick: { name: string; prev: number; now: number; rir: number | null } | null = null;
    for (const log of todayLogs) {
      if (log.weight_kg === null) continue;
      const prev = lastWeights[log.exercise_name]?.weight;
      if (typeof prev !== 'number' || prev === log.weight_kg) continue;
      if (!pick || Math.abs(log.weight_kg - prev) > Math.abs(pick.now - pick.prev)) {
        pick = { name: log.exercise_name, prev, now: log.weight_kg, rir: log.rir };
      }
    }
    if (!pick) return '';
    const tail =
      pick.rir === null ? '' :
      pick.rir >= 2 ? ', still had reps left' :
      pick.rir === 1 ? ', clean lockout' :
      ', maxed effort';
    return `${pick.name.toLowerCase()} ${pick.prev}→${pick.now}kg${tail}`;
  })();

  // Per-lift trend — for every lift trained today, take up to 3 prior
  // (strictly before today) sessions in descending recency. Tolerates
  // either history shape (with or without rir).
  const perLiftTrend: CoachRecapPerLiftTrend[] = [];
  for (const log of todayLogs) {
    const hist = exerciseHistory[log.exercise_name] ?? [];
    const recent: CoachRecapPerLiftRecent[] = [];
    for (const h of hist) {
      if (recent.length >= 3) break;
      if (!h || !h.date || h.date >= todayStr) continue; // exclude today and future
      recent.push({
        weight_kg: typeof h.weight_kg === 'number' ? h.weight_kg : null,
        rir: h.rir ?? null,
        days_ago: daysBetween(h.date, todayStr),
      });
    }
    perLiftTrend.push({ name: log.exercise_name, recent });
  }

  // Target zone — RIR 1 or 2 on at least one set today.
  const targetZoneHit = todayLogs.some(l => l.rir === 1 || l.rir === 2);

  // Trained-despite-low-energy.
  const trainedDespiteLowEnergy = energyScore <= 2 && todayLogs.length > 0;

  // Cold start — every trained lift has zero prior history.
  // Belt-and-braces: an empty today_logs also counts as cold-start, so the
  // fallback doesn't say "Push done with 0 lifts logged".
  const coldStart =
    todayLogs.length === 0 ||
    todayLogs.every(l => (exerciseHistory[l.exercise_name] ?? []).every(h => !h.date || h.date >= todayStr));

  return {
    today_logs: todayLogs,
    prs,
    energy_score: energyScore,
    streak,
    block_week: blockWeek,
    vs_last_session: vsLastSession,
    workout_type: workoutType,
    per_lift_trend: perLiftTrend,
    target_zone_hit: targetZoneHit,
    deload: planDayDeload === true,
    trained_despite_low_energy: trainedDespiteLowEnergy,
    cold_start: coldStart,
  };
}

// ─── Pure: deterministic fallback ──────────────────────────────────────

const STREAK_MILESTONES = new Set<number>([5, 7, 10, 14, 21, 30, 50, 100]);

/** Pick the heaviest weight from today_logs. Used by the workout-type
 *  fallback line so it has a concrete anchor. */
function topWeight(logs: CoachRecapTodayLog[]): { name: string; weight: number } | null {
  let pick: { name: string; weight: number } | null = null;
  for (const l of logs) {
    if (typeof l.weight_kg !== 'number') continue;
    if (!pick || l.weight_kg > pick.weight) pick = { name: l.exercise_name, weight: l.weight_kg };
  }
  return pick;
}

/** Find a lift whose today-weight is greater than the most recent prior
 *  session's weight. Returns the first such lift in the order today_logs
 *  was passed (which mirrors the session order). */
function firstProgressedLift(
  logs: CoachRecapTodayLog[],
  trend: CoachRecapPerLiftTrend[],
): { name: string; from: number; to: number } | null {
  for (const log of logs) {
    if (typeof log.weight_kg !== 'number') continue;
    const t = trend.find(p => p.name === log.exercise_name);
    const prior = t?.recent[0];
    if (!prior || typeof prior.weight_kg !== 'number') continue;
    if (log.weight_kg > prior.weight_kg) {
      return { name: log.exercise_name, from: prior.weight_kg, to: log.weight_kg };
    }
  }
  return null;
}

/**
 * Build a deterministic recap from the same facts the AI prompt sees. The
 * salience hierarchy is the contract: cold-start short-circuits, otherwise
 * we walk PR → progressed → target zone → low-energy-trained → streak
 * milestone → default. Every branch references only fields already in ctx —
 * never invents a number.
 *
 * Output: a single string, 1–2 short sentences, plain text, no emojis. The
 * fallback is the floor on quality; the AI is the upgrade.
 */
export function buildFallbackRecap(ctx: CoachRecapContext): string {
  // Cold start — never strain to reflect on absent history.
  if (ctx.cold_start) {
    return ctx.today_logs.length === 0
      ? "First one logged — I'll track your progress from here."
      : `First time on ${ctx.today_logs.length === 1 ? 'this lift' : 'these lifts'} — I'll track your progress from here.`;
  }

  // Deload weeks: no "progression" celebration regardless of numbers. The
  // dose was reduced on purpose, so the framing has to be about recovery.
  if (ctx.deload) {
    const top = topWeight(ctx.today_logs);
    const piece = top ? ` Light dose held at ${top.weight} kg on ${top.name.toLowerCase()}.` : '';
    return `Deload week — exactly the kind of session this is meant to be.${piece}`;
  }

  // 1. PR.
  if (ctx.prs.length > 0) {
    const prName = ctx.prs[0];
    const prLog = ctx.today_logs.find(l => l.exercise_name === prName);
    const w = prLog && typeof prLog.weight_kg === 'number' ? `${prLog.weight_kg} kg ` : '';
    return `PR on ${prName.toLowerCase()} — ${w}new best in the recent window. Quietly logged.`;
  }

  // 2. Progressed this block.
  const progressed = firstProgressedLift(ctx.today_logs, ctx.per_lift_trend);
  if (progressed) {
    return `${cap(progressed.name)} up to ${progressed.to} kg from ${progressed.from} kg last session — trajectory's right.`;
  }

  // 3. Hit target effort.
  if (ctx.target_zone_hit) {
    const wt = ctx.workout_type ? `${ctx.workout_type} done — ` : '';
    return `${wt}${ctx.today_logs.length} lift${ctx.today_logs.length === 1 ? '' : 's'} logged in the RIR 1–2 zone. The coach has real signal to work with.`;
  }

  // 4. Trained despite low energy.
  if (ctx.trained_despite_low_energy) {
    return `Low-energy day and you still got ${ctx.today_logs.length} lift${ctx.today_logs.length === 1 ? '' : 's'} in. That's the build.`;
  }

  // 5. Streak milestone.
  if (STREAK_MILESTONES.has(ctx.streak)) {
    return `Day ${ctx.streak} of the streak — consistency is the lift.`;
  }

  // 6. Default — one specific, light observation.
  const top = topWeight(ctx.today_logs);
  const wt = ctx.workout_type ? `${ctx.workout_type} done — ` : 'Session done — ';
  if (top) {
    return `${wt}${ctx.today_logs.length} lift${ctx.today_logs.length === 1 ? '' : 's'}, ${top.name.toLowerCase()} at ${top.weight} kg. Cleanly logged.`;
  }
  return `${wt}${ctx.today_logs.length} lift${ctx.today_logs.length === 1 ? '' : 's'} cleanly logged.`;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ─── Pure: recap sanitizer (defense in depth) ──────────────────────────
//
// The edge function already caps length and the system prompt forbids
// medical/injury advice, but the recap Path A output is rendered raw on
// the Coach tab with no other guard. This is the client-side check that
// the model obeyed: length cap + a keyword block on medical/injury/
// nutrition advice the prompt explicitly bans. On any failure the caller
// falls back to the deterministic buildFallbackRecap.

/** Hard length cap for the recap message. Matches the edge function's
 *  slice(0, 280) and the system prompt's "Under 280 characters" rule. */
const MAX_RECAP_LEN = 280;

/** Medical / injury / nutrition advice the system prompt forbids. If the
 *  model disobeyed and produced any of these, reject the line. Word-
 *  boundary, case-insensitive. */
const MEDICAL_ADVICE_RE = /\b(physio|physical therapist|doctor|see a|medical|injury|injured|hurt yourself|ice it|rest tomorrow|eat \d+|grams of protein|diagnos|rehab)\b/i;

/**
 * Validate a recap message string from the edge function. Returns the
 * trimmed message if it passes, or null if it should be rejected (caller
 * then falls back to buildFallbackRecap).
 *
 * Rules:
 *   1. Non-empty string after trim.
 *   2. ≤ MAX_RECAP_LEN (280) chars.
 *   3. No medical / injury / nutrition advice keywords.
 *   4. No emoji (same unicode guard as coachVoiceAI).
 */
export function sanitizeRecap(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_RECAP_LEN) return trimmed.slice(0, MAX_RECAP_LEN);
  if (MEDICAL_ADVICE_RE.test(trimmed)) return null;
  // Emoji guard — same range as coachVoiceAI's EMOJI_RE.
  if (/[☀-➿\u{1F300}-\u{1FAFF}]/u.test(trimmed)) return null;
  return trimmed;
}

// ─── Network call ──────────────────────────────────────────────────────

/** Default timeout — Haiku typically returns in ~1s; 8s is enough headroom
 *  for cold starts without making the finish flow feel slow. */
const DEFAULT_TIMEOUT_MS = 8000;

/** Race a promise against a timer. On timeout we resolve with the timeout
 *  sentinel rather than reject — the caller already treats both as "error". */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timeout: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timeout: true }>(resolve => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Call the coach-recap edge function. Returns a deterministic discriminated
 * union — never throws. Empty/garbage responses become 'error', not 'ok'.
 */
export async function requestCoachRecap(
  ctx: CoachRecapContext,
  opts?: { timeoutMs?: number }
): Promise<CoachRecapResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const invoke = supabase.functions.invoke('coach-recap', { body: ctx });
    const raced = await withTimeout(invoke, timeoutMs);

    if ((raced as { __timeout?: true }).__timeout) return { kind: 'error' };

    const { data, error } = raced as { data: unknown; error: unknown };
    if (error) return { kind: 'error' };

    const msg = sanitizeRecap((data as { message?: unknown } | null)?.message);
    if (!msg) return { kind: 'error' };

    return { kind: 'ok', message: msg };
  } catch {
    // Network failure, JSON parse error from the SDK, anything else — silent.
    return { kind: 'error' };
  }
}
