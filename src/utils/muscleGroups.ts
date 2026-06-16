// Map a fine-grained primary muscle to a top-level filter group.
// Used by the history/progress muscle filters so users see five groups
// (chest, back, shoulders, arms, legs) instead of every individual muscle.

export const MUSCLE_GROUP_ORDER = ['CHEST', 'BACK', 'SHOULDERS', 'ARMS', 'LEGS'] as const;

export type MuscleGroup = typeof MUSCLE_GROUP_ORDER[number];

const NORMALIZE: Record<string, MuscleGroup> = {
  chest: 'CHEST',
  back: 'BACK',
  lats: 'BACK',
  shoulders: 'SHOULDERS',
  'rear delts': 'SHOULDERS',
  biceps: 'ARMS',
  triceps: 'ARMS',
  forearms: 'ARMS',
  arms: 'ARMS',
  quads: 'LEGS',
  hamstrings: 'LEGS',
  glutes: 'LEGS',
  calves: 'LEGS',
  legs: 'LEGS',
};

export function normalizeMuscle(name: string | null | undefined): MuscleGroup | null {
  if (!name) return null;
  return NORMALIZE[name.toLowerCase().trim()] ?? null;
}
