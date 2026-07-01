// Dev-only seeder. Pour the scenario blueprints from devScenarios.ts into
// the real backend via the existing write helpers — never a parallel fake.
//
// IMPORTANT: this file is __DEV__ in spirit; the menu surface that calls it
// is hard-gated behind __DEV__, but the helpers themselves stay
// import-safe so the test suite can poke at them. Nothing here should be
// called from production code paths.
//
// Wipe semantics: every call wipes the CURRENT user's account-derived state
// (workout_sessions, exercise_logs, weekly_plans rows + all history-derived
// AsyncStorage entries) before seeding, so reseeding is idempotent: same id
// twice = same state. Auth, notification time, gym/home location, and the
// notification-permission-asked flag are deliberately preserved — those are
// device preferences, not account state, and re-priming them every reseed
// would be hostile.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportSilent } from './errorReporting';
import { supabase } from './supabase';
import { buildScenario, type ResolvedScenario, type ScenarioId } from './devScenarios';
import {
  attemptSaveWithRetry,
  type PendingLogRow,
  type PendingSave,
  type PendingSessionFields,
} from './pendingSync';
import { ensureCurrentWeekPlan, writeCachedProfileInputs } from './planSync';
import { writePinnedHeroFactSig } from './coachHeroPin';
// The wipe inventory lives in a dep-free module so the unit tests can pin
// it without pulling in supabase / react-native. Re-export the constants
// and picker here for callers that already import `devSeed` directly.
import { pickHistoryKeysToWipe } from './devSeedKeys';
export {
  HISTORY_EXACT_KEYS,
  HISTORY_PREFIX_KEYS,
  PRESERVE_KEYS,
  pickHistoryKeysToWipe,
} from './devSeedKeys';

// ── Seed result shape ──────────────────────────────────────────────────

export interface SeedResult {
  ok: boolean;
  scenarioId: string;
  /** One-line human-readable status. Surface this in the dev UI. */
  summary: string;
  /** Failure breadcrumbs — every helper call that errored, tagged. Never
   *  empty when ok=false; sometimes non-empty when ok=true (a partial
   *  failure that didn't block the seed, e.g. a single log batch). */
  errors: { stage: string; message: string }[];
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Wipe + seed the CURRENT signed-in user with the named scenario.
 *
 * Order is the contract:
 *   1. Wipe Supabase rows (workout_sessions, exercise_logs, weekly_plans).
 *      RLS scopes every delete to auth.uid() by construction.
 *   2. Wipe history-derived AsyncStorage (per pickHistoryKeysToWipe).
 *   3. Write profile via upsert (real columns the migration added).
 *   4. Write each historical session via attemptSaveWithRetry — the SAME
 *      helper finishWorkout uses, so the row shape can't drift.
 *   5. Optionally insert the artificial weekly_plans block-anchor row.
 *   6. ensureCurrentWeekPlan to materialize today's row from the seeded
 *      profile (forces a regen).
 *   7. Optional postSeed hooks (e.g. stale hero pin).
 *
 * Never throws. All failures funnel into the returned SeedResult so the
 * dev UI can surface them and the JS error boundary stays untouched.
 *
 * Defense-in-depth: the FIRST line refuses to run when `__DEV__` is false,
 * regardless of how the call arrived. The dev menu also gates on __DEV__
 * (and the entry-point long-press is __DEV__-only), but a future caller
 * — analytics replay, a misconfigured test harness, a deep link — could
 * still reach this function. The early-return makes it impossible for ANY
 * caller to delete rows in a release build.
 */
export async function seedScenario(scenarioId: ScenarioId): Promise<SeedResult> {
  if (!__DEV__) {
    return {
      ok: false,
      scenarioId,
      summary: 'Refused: dev-only operation.',
      errors: [{ stage: 'guard', message: 'dev only' }],
    };
  }

  const errors: SeedResult['errors'] = [];
  const tag = (stage: string, e: unknown) => {
    const message = e instanceof Error ? e.message : safeStringify(e);
    errors.push({ stage, message });
    reportSilent(e, `devSeed:${stage}`);
  };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      scenarioId,
      summary: 'No signed-in user — seed aborted.',
      errors: [{ stage: 'auth', message: 'no user' }],
    };
  }

  let resolved: ResolvedScenario;
  try {
    resolved = buildScenario(scenarioId);
  } catch (e) {
    tag('buildScenario', e);
    return {
      ok: false,
      scenarioId,
      summary: `Unknown scenario "${scenarioId}".`,
      errors,
    };
  }

  // 1. Wipe Supabase. exercise_logs has ON DELETE CASCADE on its session
  //    FK, but we delete it explicitly anyway in case rows exist without a
  //    parent session (legacy / migration artefact). All three deletes are
  //    RLS-scoped to auth.uid() — we add the explicit user_id filter to
  //    keep this safe even if a future RLS misconfig opens up the table.
  await wipeSupabase(user.id, tag);

  // 2. Wipe AsyncStorage.
  await wipeAsyncStorage(tag);

  // 3. Profile upsert. We write every column the scenario covers so a
  //    reseed of the SAME scenario is byte-identical, and a switch from
  //    one scenario to another always replaces the relevant fields.
  try {
    const p = resolved.profile;
    const { error } = await supabase.from('profiles').upsert({
      id: user.id,
      fitness_level: p.fitness_level,
      goal: p.goal,
      priority: p.priority,
      bodyweight_kg: p.bodyweight_kg,
      sex: p.sex,
      training_days: p.training_days,
      preferred_split: p.preferred_split,
      training_weekdays: p.training_weekdays,
      onboarding_complete: true,
    });
    if (error) tag('profile_upsert', error);
  } catch (e) {
    tag('profile_upsert', e);
  }

  // Cache mirror — same write path onboarding uses so the offline read
  // fallback inside ensureCurrentWeekPlan resolves to the seeded values.
  try {
    await writeCachedProfileInputs({
      training_days: resolved.profile.training_days,
      preferred_split: resolved.profile.preferred_split,
      fitness_level: resolved.profile.fitness_level,
      training_weekdays: resolved.profile.training_weekdays,
    });
  } catch (e) {
    tag('cache_profile_inputs', e);
  }

  // 4. Sessions via attemptSaveWithRetry. Each session writes one
  //    workout_sessions row + N exercise_logs in one batch — the exact
  //    shape finishWorkout produces. completed=true so dashboard reads
  //    and training-status pick them up immediately.
  for (const s of resolved.sessions) {
    const sessionFields: PendingSessionFields = {
      user_id: user.id,
      planned_date: s.plannedDate,
      workout_type: s.workoutType,
      location: 'gym',
      energy_level: s.energyLevel,
      energy_score: s.energyScore,
      exercises_done: s.logs.map(l => ({
        name: l.exercise_name,
        weight_kg: l.weight_kg,
        rir: l.reps_in_reserve,
      })),
      completed: true,
      completed_at: new Date(`${s.plannedDate}T18:00:00`).toISOString(),
      replanned: false,
      is_recovery: false,
    };
    const logRows: PendingLogRow[] = s.logs.map(l => ({
      user_id: user.id,
      exercise_name: l.exercise_name,
      weight_kg: l.weight_kg,
      logged_date: s.plannedDate,
      session_id: null, // attemptSave wires the id once the session row exists
      reps_in_reserve: l.reps_in_reserve,
      is_recovery: false,
    }));
    const save: PendingSave = {
      userId: user.id,
      plannedDate: s.plannedDate,
      session: sessionFields,
      logRows,
      queuedAt: new Date().toISOString(),
    };
    const result = await attemptSaveWithRetry(save);
    if (!result.ok) {
      tag(`session_save:${s.plannedDate}`, result.error);
    }
  }

  // 5. Optional artificial block-anchor row. We bypass ensureCurrentWeekPlan
  //    here on purpose — the goal is to give the anchor query a row to
  //    READ, not to materialize meaningful plan data. The plan blob is
  //    intentionally empty; ensureCurrentWeekPlan in step 6 will treat
  //    today's row as the active week and regenerate from the user's
  //    profile, with the block math anchored on this row's week_start.
  if (resolved.blockAnchorWeekStart) {
    try {
      const { error } = await supabase.from('weekly_plans').upsert(
        {
          user_id: user.id,
          week_start: resolved.blockAnchorWeekStart,
          plan: [],
          plan_version: 0,
        },
        { onConflict: 'user_id,week_start' },
      );
      if (error) tag('block_anchor_upsert', error);
    } catch (e) {
      tag('block_anchor_upsert', e);
    }
  }

  // 6. Force-regenerate the current + future week plan rows from the
  //    seeded profile. force:true wipes future rows so today's window is
  //    deterministic regardless of what was there before the seed.
  try {
    await ensureCurrentWeekPlan({ force: true });
  } catch (e) {
    tag('ensureCurrentWeekPlan', e);
  }

  // 7. Optional postSeed hooks.
  if (resolved.postSeed?.heroPin === 'rest-today') {
    try {
      await writePinnedHeroFactSig(user.id, resolved.todayIso, `rest-${resolved.todayIso}`);
    } catch (e) {
      tag('postSeed:heroPin', e);
    }
  }

  return {
    ok: errors.length === 0,
    scenarioId,
    summary: errors.length === 0
      ? `Seeded "${resolved.label}" (${resolved.sessions.length} sessions).`
      : `Seeded "${resolved.label}" with ${errors.length} non-fatal error(s).`,
    errors,
  };
}

/**
 * Wipe-to-fresh-account path. Same as seedScenario('fresh_cold_start') but
 * skips the profile upsert so the user must re-onboard from a truly empty
 * row. Used by the dev menu's "wipe" affordance.
 *
 * Defense-in-depth: matches seedScenario's first-line __DEV__ guard. A
 * release build refuses the call with NO deletes/writes, regardless of
 * who invoked it.
 */
export async function wipeToFreshAccount(): Promise<SeedResult> {
  if (!__DEV__) {
    return {
      ok: false,
      scenarioId: 'wipe',
      summary: 'Refused: dev-only operation.',
      errors: [{ stage: 'guard', message: 'dev only' }],
    };
  }

  const errors: SeedResult['errors'] = [];
  const tag = (stage: string, e: unknown) => {
    const message = e instanceof Error ? e.message : safeStringify(e);
    errors.push({ stage, message });
    reportSilent(e, `devSeed:${stage}`);
  };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      scenarioId: 'wipe',
      summary: 'No signed-in user — wipe aborted.',
      errors: [{ stage: 'auth', message: 'no user' }],
    };
  }

  await wipeSupabase(user.id, tag);
  await wipeAsyncStorage(tag);

  // Reset the profile to a minimally-cleared state: keep id + username,
  // clear the plan-shaping + onboarding fields so the next launch goes
  // through onboarding again.
  try {
    const { error } = await supabase
      .from('profiles')
      .update({
        fitness_level: null,
        goal: null,
        priority: null,
        bodyweight_kg: null,
        sex: null,
        training_days: null,
        preferred_split: null,
        training_weekdays: null,
        onboarding_complete: false,
      })
      .eq('id', user.id);
    if (error) tag('profile_reset', error);
  } catch (e) {
    tag('profile_reset', e);
  }

  return {
    ok: errors.length === 0,
    scenarioId: 'wipe',
    summary: errors.length === 0
      ? 'Account wiped to fresh — re-launch lands in onboarding.'
      : `Wipe completed with ${errors.length} non-fatal error(s).`,
    errors,
  };
}

// ── Internals ──────────────────────────────────────────────────────────

async function wipeSupabase(userId: string, tag: (stage: string, e: unknown) => void): Promise<void> {
  // Order matters when there's no cascade: child rows first, then parents.
  // exercise_logs.session_id has ON DELETE CASCADE per the migration
  // (20260615...exercise_logs_cascade_on_delete.sql), but we delete it
  // explicitly first to remove any orphan rows that predate the cascade.
  try {
    const { error } = await supabase.from('exercise_logs').delete().eq('user_id', userId);
    if (error) tag('wipe:exercise_logs', error);
  } catch (e) {
    tag('wipe:exercise_logs', e);
  }
  try {
    const { error } = await supabase.from('workout_sessions').delete().eq('user_id', userId);
    if (error) tag('wipe:workout_sessions', error);
  } catch (e) {
    tag('wipe:workout_sessions', e);
  }
  try {
    const { error } = await supabase.from('weekly_plans').delete().eq('user_id', userId);
    if (error) tag('wipe:weekly_plans', error);
  } catch (e) {
    tag('wipe:weekly_plans', e);
  }
}

async function wipeAsyncStorage(tag: (stage: string, e: unknown) => void): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const toRemove = pickHistoryKeysToWipe([...allKeys]);
    if (toRemove.length > 0) {
      await AsyncStorage.multiRemove(toRemove);
    }
  } catch (e) {
    tag('wipe:asyncStorage', e);
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
