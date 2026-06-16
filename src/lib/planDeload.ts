// Pure transforms for the tap-to-accept deload actions (early / skip).
//
// Mirrors src/lib/planSwap.ts: the caller fetches the materialized
// weekly_plans rows, calls a transform, and upserts only the changed rows
// back (fire-and-forget, re-stamping CURRENT_PLAN_VERSION). No Supabase, no
// clock here — the transform is unit-testable in isolation.
//
// SELF-HEAL SAFETY (same guarantee swaps rely on): ensureCurrentWeekPlan's
// active-week heal compares (date, workoutType) pairs ONLY (see
// weekRowMatchesCanonical in planCatchUp.ts). A deload changes sets / reps /
// the deload flag — never the date or workoutType — so a deloaded (or
// un-deloaded) active row still reads as canonical and is NOT reverted on
// the next open. Future rows are gated by plan_version, so the caller
// re-stamps CURRENT_PLAN_VERSION and they stay satisfied too.
//
// EXPIRY AT BLOCK BOUNDARY: these transforms only ever touch already-
// materialized rows from today forward. The next block's rows are generated
// later by generatePlan at the natural block position, so a pulled-forward
// deload (or a skipped one) never leaks past the current block — same expiry
// mechanism as a swap.

import { deloadSets, deloadReps } from './planGeneration';

export interface PlanExerciseLike {
  name: string;
  sets: number;
  reps: string | number;
  restSeconds?: number;
  primaryMuscle?: string;
  equipment?: string;
  imageUrl?: string;
}

export interface PlanDayLike {
  day?: string;
  date?: string | null;
  location?: string;
  workoutType?: string;
  muscleGroups?: string[];
  exercises?: PlanExerciseLike[];
  deload?: boolean;
}

export interface PlanRowLike {
  weekStart: string;
  days: PlanDayLike[];
}

export interface DeloadTransformArgs {
  /** Rows from today forward (caller pre-filters to week_start >= today-6 so
   *  the row covering today is included). */
  rows: ReadonlyArray<PlanRowLike>;
  /** Local YYYY-MM-DD. Days dated strictly before this are left untouched —
   *  the change applies from today forward only. A missing date (legacy row)
   *  is treated as eligible. */
  todayIso: string;
}

export interface DeloadTransformResult {
  /** Only the rows that actually changed — caller upserts just these. */
  changedRows: PlanRowLike[];
}

/** Approximate inverse of deloadSets (ceil(0.6·s)). The forward map is lossy
 *  (4 and 5 both → 3), so we can't recover the exact original; restoring
 *  round(reduced / 0.6) brings volume back UP, which is the right bias for a
 *  user who explicitly chose to skip the deload and keep pushing. Floors at 1.
 *    2 → 3, 3 → 5 (was 4 or 5), 4 → 7. */
export function undeloadSets(reduced: number): number {
  if (!Number.isFinite(reduced) || reduced <= 0) return 1;
  return Math.max(1, Math.round(reduced / 0.6));
}

/** Exact inverse of deloadReps (which adds +2): subtract 2, floor at 1.
 *  "8-10" → "6-8", "12" → "10", number → number-2. Unparseable left as-is. */
export function undeloadReps(reps: string | number | undefined): string | number | undefined {
  if (reps == null) return reps;
  if (typeof reps === 'number') return Math.max(1, reps - 2);
  const range = reps.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (range) {
    return `${Math.max(1, parseInt(range[1], 10) - 2)}-${Math.max(1, parseInt(range[2], 10) - 2)}`;
  }
  const single = reps.match(/^\s*(\d+)\s*$/);
  if (single) return String(Math.max(1, parseInt(single[1], 10) - 2));
  return reps;
}

function dayEligible(day: PlanDayLike, todayIso: string): boolean {
  if (day?.date && day.date < todayIso) return false;
  return true;
}

/**
 * PULL FORWARD — turn the supplied days (from today forward) into a deload:
 * reduce each exercise's sets via deloadSets, bump reps via deloadReps, and
 * stamp PlanDay.deload = true. Exercises are preserved exactly (same
 * comparability the scheduled deload relies on).
 *
 * Idempotent: a day already marked deload is left untouched (not reported as
 * changed), so re-running is a no-op.
 */
export function applyDeloadToRows(args: DeloadTransformArgs): DeloadTransformResult {
  const { rows, todayIso } = args;
  const changedRows: PlanRowLike[] = [];

  for (const row of rows) {
    let rowChanged = false;
    const newDays = (row.days ?? []).map(day => {
      if (!dayEligible(day, todayIso)) return day;
      if (day?.deload === true) return day; // already deloaded — no-op
      const exercises = day?.exercises ?? [];
      const nextExercises = exercises.map(ex => ({
        ...ex,
        sets: deloadSets(ex.sets),
        reps: deloadReps(ex.reps) as string | number,
      }));
      rowChanged = true;
      return { ...day, exercises: nextExercises, deload: true };
    });
    if (rowChanged) changedRows.push({ weekStart: row.weekStart, days: newDays });
  }

  return { changedRows };
}

/**
 * SKIP — turn the supplied deload days (from today forward) back into a
 * normal training week: restore sets via undeloadSets, reps via undeloadReps,
 * and clear PlanDay.deload. Exercises are preserved exactly.
 *
 * Idempotent: a day that isn't a deload is left untouched (not reported as
 * changed).
 */
export function clearDeloadFromRows(args: DeloadTransformArgs): DeloadTransformResult {
  const { rows, todayIso } = args;
  const changedRows: PlanRowLike[] = [];

  for (const row of rows) {
    let rowChanged = false;
    const newDays = (row.days ?? []).map(day => {
      if (!dayEligible(day, todayIso)) return day;
      if (day?.deload !== true) return day; // not a deload — no-op
      const exercises = day?.exercises ?? [];
      const nextExercises = exercises.map(ex => ({
        ...ex,
        sets: undeloadSets(ex.sets),
        reps: undeloadReps(ex.reps) as string | number,
      }));
      rowChanged = true;
      return { ...day, exercises: nextExercises, deload: false };
    });
    if (rowChanged) changedRows.push({ weekStart: row.weekStart, days: newDays });
  }

  return { changedRows };
}

/** Unwrap the weekly_plans `plan` column — array, or legacy { days: [...] }. */
export function extractPlanDays(plan: unknown): PlanDayLike[] {
  if (Array.isArray((plan as any)?.days)) return (plan as any).days;
  if (Array.isArray(plan)) return plan as PlanDayLike[];
  return [];
}
