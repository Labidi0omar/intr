// Persist an in-session exercise swap into the materialized weekly_plans
// rows so it sticks for the rest of the current mesocycle block.
//
// Scope = "until the next block". We only ever rewrite rows that already
// exist in weekly_plans (the current block's horizon). The next block's
// rows are generated later by generatePlan, which reselects exercises from
// the catalog, so the swap simply never reaches them — the expiry is a
// consequence of only touching materialized rows, not an explicit TTL.
//
// Pure: no Supabase, no clock. The caller fetches the rows, calls
// applySwapToRows, and upserts the changed rows back. This keeps the
// transform unit-testable and the I/O thin + error-tolerant in workout.tsx.
//
// Self-heal note: ensureCurrentWeekPlan's heal compares (date, workoutType)
// pairs ONLY (see weekRowMatchesCanonical in planCatchUp.ts). A swap changes
// neither, so a swapped row stays "canonical" and is never reverted. Future
// rows are gated by plan_version, so the caller re-stamps CURRENT_PLAN_VERSION
// on upsert and they stay satisfied too.

import type { ExerciseEntry } from '../constants/exercises';

export interface PlanExerciseLike {
  name: string;
  sets: number;
  reps: string | number;
  restSeconds: number;
  primaryMuscle: string;
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

/** Catalog fields we copy onto the replacement exercise. */
export type SwapCatalogEntry = Pick<
  ExerciseEntry,
  'name' | 'reps' | 'restSeconds' | 'equipment' | 'imageUrl' | 'primaryMuscle'
>;

/** Build the replacement plan-exercise from a catalog entry, carrying the
 *  original `sets` (the user's prescribed volume for that slot — preserved
 *  so a deload day keeps its reduced sets) and taking everything else from
 *  the catalog. */
export function buildSwapExercise(
  entry: SwapCatalogEntry,
  originalSets: number,
): PlanExerciseLike {
  return {
    name: entry.name,
    sets: originalSets,
    reps: entry.reps,
    restSeconds: entry.restSeconds,
    primaryMuscle: entry.primaryMuscle,
    equipment: entry.equipment,
    imageUrl: entry.imageUrl,
  };
}

export interface ApplySwapArgs {
  /** Rows from today forward (caller pre-filters to week_start >= today-6 so
   *  the row covering today is included). */
  rows: ReadonlyArray<PlanRowLike>;
  /** Local YYYY-MM-DD. Days dated strictly before this are left untouched —
   *  the swap applies from today forward only. */
  todayIso: string;
  /** Only days of this workoutType are affected (e.g. all upcoming "Legs"). */
  workoutType: string;
  /** Exercise name being swapped OUT (matched case-insensitively). */
  swapOutName: string;
  /** Catalog entry being swapped IN. */
  replacementEntry: SwapCatalogEntry;
}

export interface ApplySwapResult {
  /** Only the rows that actually changed — caller upserts just these. */
  changedRows: PlanRowLike[];
}

/**
 * Replace `swapOutName` with `replacementEntry` in every matching-workoutType
 * day from today forward, across the supplied rows. Returns only the rows
 * that changed.
 *
 * Guards:
 *  - Match + replace by exercise name within the matching workoutType day.
 *  - Never create a duplicate: if the day already contains the replacement
 *    exercise (in another slot), that day is left unchanged.
 *  - Idempotent: once the swap-out name is gone from a day, re-applying is a
 *    no-op (the day isn't reported as changed).
 *  - Past days (date < todayIso) are skipped; days without a date are treated
 *    as eligible (legacy rows).
 */
export function applySwapToRows(args: ApplySwapArgs): ApplySwapResult {
  const { rows, todayIso, workoutType, swapOutName, replacementEntry } = args;
  const outLower = swapOutName.toLowerCase();
  const inLower = replacementEntry.name.toLowerCase();
  const changedRows: PlanRowLike[] = [];

  for (const row of rows) {
    let rowChanged = false;
    const newDays = (row.days ?? []).map(day => {
      if (day?.workoutType !== workoutType) return day;
      // From-today-forward: skip days that already happened. A missing date
      // (legacy row) is treated as eligible.
      if (day.date && day.date < todayIso) return day;
      const exercises = day.exercises ?? [];
      const idx = exercises.findIndex(e => e?.name?.toLowerCase() === outLower);
      if (idx === -1) return day; // swap-out not in this day (or already swapped)
      // Duplicate guard: replacement already present in another slot.
      const dupElsewhere = exercises.some(
        (e, i) => i !== idx && e?.name?.toLowerCase() === inLower,
      );
      if (dupElsewhere) return day;
      const replacement = buildSwapExercise(replacementEntry, exercises[idx].sets);
      const nextExercises = exercises.slice();
      nextExercises[idx] = replacement;
      rowChanged = true;
      return { ...day, exercises: nextExercises };
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
