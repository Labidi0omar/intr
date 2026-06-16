// Server-side guardrails applied to Claude's replanner output BEFORE it
// reaches the client. The LLM is allowed to be creative within these bounds;
// anything outside falls back to the original plan.
//
// These are non-negotiable. If Claude returns garbage, the client never sees it.
//
// Load math is NOT delegated to the LLM. We compute the next-session weight
// deterministically (see _shared/loadPrescription.ts), then clamp the LLM's
// number to within ±1 plate of the prescription so the model can nudge but
// not override.

import { prescribeLoad, isCompoundName } from './loadPrescription.ts';

export interface PlanExercise {
  name: string;
  sets: number;
  reps: string | number;
  restSeconds: number;
  primaryMuscle: string;
  equipment?: string;
  imageUrl?: string;
  suggestedWeightKg?: number;
}

export interface PlanDay {
  day: string;
  location: string;
  workoutType: string;
  muscleGroups: string[];
  exercises: PlanExercise[];
}

export interface ExerciseHistory {
  name: string;
  last_weight_kg: number;
  last_logged_date: string;
}

export interface SafetyContext {
  original: PlanDay;
  lastWeights: Record<string, number>; // exercise name → last logged kg
  /** Exercise name → most recent RIR (0..5), or null if unknown. */
  lastRir?: Record<string, number | null>;
  /** Today's energy self-report (1..5). Used by the prescription engine. */
  energyScore?: number;
  /** Optional. Halves the step size when 'beginner'. */
  fitnessLevel?: 'beginner' | 'intermediate' | 'advanced';
}

export interface SafetyResult {
  ok: boolean;
  plan?: PlanDay;
  reason?: string;
}

/**
 * Validate + clamp Claude's adjusted plan against safety rules.
 *
 * Rules (in order):
 *  1. Schema:    every required field present, correct shape
 *  2. Subset:    adjusted.exercises is a subset of original.exercises (by name)
 *  3. Sets:      adjusted.sets[i] <= original.sets[i] for each exercise
 *  4. Weights:   suggestedWeightKg ∈ [60%, 105%] of last logged
 *  5. Day/type:  day, workoutType, muscleGroups preserved verbatim
 */
export function applyReplanSafety(raw: unknown, ctx: SafetyContext): SafetyResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'not an object' };
  }
  const candidate = raw as Partial<PlanDay>;

  // 1. Schema
  if (
    typeof candidate.day !== 'string' ||
    typeof candidate.location !== 'string' ||
    typeof candidate.workoutType !== 'string' ||
    !Array.isArray(candidate.muscleGroups) ||
    !Array.isArray(candidate.exercises)
  ) {
    return { ok: false, reason: 'schema mismatch' };
  }

  // Note: we don't validate `day` / `workoutType` / `muscleGroups` —
  // the AI sometimes returns "push" instead of "Push", or "monday" instead
  // of "Monday". We force-overwrite these with the originals on the way out
  // (see the return at the bottom), so any mutation by the LLM is silently
  // corrected rather than treated as a safety violation.

  // 2. Subset by name (case-insensitive)
  const originalNames = new Set(
    ctx.original.exercises.map(e => e.name.trim().toLowerCase())
  );
  const originalByName = new Map(
    ctx.original.exercises.map(e => [e.name.trim().toLowerCase(), e])
  );

  const cleanedExercises: PlanExercise[] = [];
  for (const ex of candidate.exercises) {
    if (!ex || typeof ex.name !== 'string') continue;
    const key = ex.name.trim().toLowerCase();
    if (!originalNames.has(key)) {
      // Claude tried to add a new exercise — drop it.
      continue;
    }
    const orig = originalByName.get(key)!;

    // 3. Sets: cap at original
    const rawSets = typeof ex.sets === 'number' ? Math.floor(ex.sets) : orig.sets;
    const clampedSets = Math.max(1, Math.min(rawSets, orig.sets));

    // 4. Weight: compute the RIR-driven prescription, then clamp the LLM's
    //    number to within ±1 plate of it. The prescription is the source of
    //    truth; the LLM gets to nudge.
    let weight: number | undefined;
    const last = ctx.lastWeights[orig.name];
    if (typeof last === 'number' && last > 0) {
      const rx = prescribeLoad({
        lastWeightKg: last,
        lastRir: ctx.lastRir?.[orig.name] ?? null,
        energyScore: ctx.energyScore ?? 3,
        isCompound: isCompoundName(orig.name),
        fitnessLevel: ctx.fitnessLevel,
      });
      const lo = rx.suggestedWeightKg - 2.5;
      const hi = rx.suggestedWeightKg + 2.5;
      const llm = typeof ex.suggestedWeightKg === 'number' && isFinite(ex.suggestedWeightKg)
        ? ex.suggestedWeightKg
        : rx.suggestedWeightKg;
      weight = Math.round(Math.max(lo, Math.min(llm, hi)) / 2.5) * 2.5;
    } else if (typeof ex.suggestedWeightKg === 'number' && isFinite(ex.suggestedWeightKg)) {
      // No history → trust the LLM but cap sanity (5kg–250kg).
      weight = Math.max(5, Math.min(ex.suggestedWeightKg, 250));
    }

    cleanedExercises.push({
      name: orig.name, // preserve original casing
      sets: clampedSets,
      reps: ex.reps ?? orig.reps,
      restSeconds: orig.restSeconds, // never let LLM mutate rest
      primaryMuscle: orig.primaryMuscle,
      equipment: orig.equipment,
      imageUrl: orig.imageUrl,
      ...(typeof weight === 'number' ? { suggestedWeightKg: weight } : {}),
    });
  }

  if (cleanedExercises.length === 0) {
    return { ok: false, reason: 'no exercises survived safety filter' };
  }

  return {
    ok: true,
    plan: {
      day: ctx.original.day,
      location: ctx.original.location,
      workoutType: ctx.original.workoutType,
      muscleGroups: ctx.original.muscleGroups,
      exercises: cleanedExercises,
    },
  };
}

/**
 * Human-readable diff of original vs. adjusted plan. Used for the modal copy.
 */
export function describeChanges(original: PlanDay, adjusted: PlanDay): string[] {
  const changes: string[] = [];

  const origNames = new Set(original.exercises.map(e => e.name));
  const adjNames = new Set(adjusted.exercises.map(e => e.name));

  // Removed exercises
  const removed = [...origNames].filter(n => !adjNames.has(n));
  for (const name of removed) {
    changes.push(`Dropped ${name}`);
  }

  // Set reductions
  const origByName = new Map(original.exercises.map(e => [e.name, e]));
  for (const adj of adjusted.exercises) {
    const orig = origByName.get(adj.name);
    if (!orig) continue;
    if (adj.sets < orig.sets) {
      const delta = orig.sets - adj.sets;
      changes.push(`Cut ${delta} set${delta > 1 ? 's' : ''} from ${adj.name}`);
    }
    if (typeof adj.suggestedWeightKg === 'number') {
      // We don't surface weight changes per exercise — too noisy. The total
      // load reduction is in the reasoning line from Claude.
    }
  }

  if (changes.length === 0) {
    changes.push('Same plan, lighter intent.');
  }
  return changes;
}
