// Derive the muscles an exercise trains from its primaryMuscle field.
// Pure, no React, no network.
//
// TODAY: returns only the exercise's primary muscle. The earlier
// bucket-mates derivation (other muscles in the same muscleGroups
// bucket) was anatomically wrong — it treated antagonists as
// synergists (biceps curl → triceps) and missed real synergists
// living in other buckets (bench press → delts, triceps). We removed
// it rather than ship a wrong list.
//
// TODO: real secondary-muscle data belongs on the exercise catalog
// entries (something like `secondaryMuscles?: string[]` on
// ExerciseEntry), populated per-exercise from anatomy. Once that's
// authored, extend this to fan those out as `role: 'supporting'`
// entries; MuscleDetails's rendering path already handles the general
// N-muscle case (staggered fades, muted teal, label-only for
// off-view muscles), so no consumer change needed here.
//
// Consumers: MuscleDetails on the workout screen.

import { getMuscleInfo } from '../constants/muscleInfo';

export type MuscleRole = 'primary' | 'supporting';

export interface WorkedMuscle {
  /** Lowercase muscle key — the muscleInfo lookup handle. */
  key: string;
  role: MuscleRole;
}

/**
 * Derive the ordered list of worked muscles for an exercise. Returns
 * a single-entry list containing the primary mover today. When the
 * primary isn't resolvable in muscleInfo the caller gets an empty
 * list and renders nothing rather than a broken figure.
 */
export function deriveWorkedMuscles(primaryMuscle: string | null | undefined): WorkedMuscle[] {
  if (!primaryMuscle) return [];
  const primary = primaryMuscle.toLowerCase().trim();
  if (!getMuscleInfo(primary)) return [];
  return [{ key: primary, role: 'primary' }];
}
