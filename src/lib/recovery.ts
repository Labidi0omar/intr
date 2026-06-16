// Recovery / prehab session exclusion boundary.
//
// The product rule: recovery sessions count toward streak/habit but are
// INVISIBLE to load progression, PR detection, RIR autoregulation, and the
// mesocycle. If recovery sets leak into those systems, the coach starts
// pulling progression decisions from light-dose prehab and the entire RIR
// engine drifts.
//
// Source of truth: workout_sessions.is_recovery and exercise_logs.is_recovery
// (added in supabase/migrations/20260612000000_recovery_sessions.sql). Every
// consumer that reads these tables for TRAINING context goes through one of
// the helpers in this file rather than scattering boolean checks.
//
// ─── Read-site audit ──────────────────────────────────────────────────
// Every code path that reads workout_sessions or exercise_logs:
//
//   app/workout.tsx
//     fetchTodayPlan → exercise_logs (lastWeights, exerciseHistory)
//        EXCLUDES recovery (.eq('is_recovery', false)) — load coach must
//        never see recovery weights as "your last set".
//     finishWorkout → exercise_logs (previousLogs for PR detection)
//        EXCLUDES recovery — a 5kg prehab dumbbell row must not register
//        as a new bench-press PR.
//     finishWorkout → workout_sessions (existing-session lookup)
//        EXCLUDES recovery via pendingSync.attemptSave scoping by
//        is_recovery, so a normal save never updates a recovery row and
//        vice-versa even when both happen on the same date.
//
//   src/lib/pendingSync.ts
//     attemptSave → workout_sessions lookup scoped by is_recovery (matches
//        save.session.is_recovery, defaults false). Writes is_recovery
//        explicitly on insert AND on every exercise_logs row.
//
//   src/utils/dashboardStats.ts
//     computeEffortZone / computeStrengthTrend (async wrappers) → exercise_logs
//        EXCLUDES recovery. Pure helpers also skip is_recovery=true rows so
//        the boundary holds even when callers prefetch.
//
//   supabase/functions/replan-today/index.ts
//     exercise_logs read for prescription context
//        EXCLUDES recovery — the AI replanner sees the same history the
//        client-side load coach does.
//
//   app/(tabs)/profile.tsx
//     exercise_logs for weight history graph
//        EXCLUDES recovery — light prehab weights would deform the trend.
//
//   app/(tabs)/progress.tsx
//     exercise_logs for progress display
//        EXCLUDES recovery.
//
//   src/utils/streak.ts
//     workout_sessions for streak / consistency / 7-day strips
//        INCLUDES recovery — the streak counts any completed session,
//        recovery or normal. This is the asymmetric piece: invisible to
//        the coach, visible to the habit tracker.
//
//   src/utils/monthCalendar.ts
//     workout_sessions completedDates → INCLUDES recovery. Calendar marker
//        is "did you do anything that day" — recovery counts.
//
//   app/(tabs)/home.tsx → workout_sessions for recent sessions display
//        INCLUDES recovery (display-only; doesn't influence the coach).
//
//   src/utils/streak.ts getNextSevenDays/getLastSevenDays → strip dots
//        INCLUDE recovery (display-only).

/** Minimal shape needed to evaluate the recovery flag on a session-like row. */
export interface RecoverySessionLike {
  is_recovery?: boolean | null;
  /** Legacy fallback: rows written before the column existed (and any future
   *  display layer that constructs sessions client-side) can carry the tag
   *  in `workout_type`. We treat 'Recovery' / 'Recovery — …' as recovery. */
  workout_type?: string | null;
}

/** Minimal shape needed to evaluate the recovery flag on a log-like row. */
export interface RecoveryLogLike {
  is_recovery?: boolean | null;
}

/** Workout-type prefix reserved for recovery sessions. Display layers may
 *  format it as "Recovery" or "Recovery — Mobility"; the prefix check
 *  catches both. */
export const RECOVERY_WORKOUT_TYPE_PREFIX = 'Recovery';

/**
 * True iff this session must NOT influence load coaching, PR detection,
 * RIR autoregulation, or the mesocycle.
 *
 * Primary signal is the boolean column; the workout_type prefix is a
 * belt-and-suspenders fallback for legacy rows or client-built session
 * objects that haven't been persisted yet.
 */
export function isRecoverySession(row: RecoverySessionLike | null | undefined): boolean {
  if (!row) return false;
  if (row.is_recovery === true) return true;
  if (typeof row.workout_type === 'string' && row.workout_type.startsWith(RECOVERY_WORKOUT_TYPE_PREFIX)) {
    return true;
  }
  return false;
}

/** True iff this exercise_logs row was written by a recovery session and
 *  must be filtered out of training history (load prescription, PR detection,
 *  effort zone, strength trend). */
export function isRecoveryLog(row: RecoveryLogLike | null | undefined): boolean {
  return !!row && row.is_recovery === true;
}

/** Drop recovery rows from a logs array. Pure; useful where the caller has
 *  prefetched a mix of training + recovery rows and wants the training-only
 *  subset for downstream maths. */
export function filterTrainingLogs<T extends RecoveryLogLike>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const r of rows) if (!isRecoveryLog(r)) out.push(r);
  return out;
}

/** Drop recovery sessions from a sessions array. Pure. */
export function filterTrainingSessions<T extends RecoverySessionLike>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const r of rows) if (!isRecoverySession(r)) out.push(r);
  return out;
}
