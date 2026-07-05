/// <reference types="node" />
// Drop-guardrail unit tests for the Deno-side safety module. Import path
// mirrors loadPrescription.parity.test.ts — jest resolves the .ts file
// directly from the supabase/functions tree.
//
// What we pin:
//   1. Energy > 2 → any exercise the LLM removed is RESTORED (LLM's edits
//      on kept exercises survive).
//   2. Energy 1–2 → drops allowed but keep the warm-up + minimum-count floor.
//   3. `restored` array reports the names so the caller can log
//      'replan:dropGuard' telemetry.
//   4. The prompt-only rule is dead code without this — the whole point of
//      the guardrail is that it fires without trusting the LLM.

import {
  applyReplanSafety,
  type PlanDay,
} from '../../supabase/functions/_shared/safety';

// ── Fixtures ─────────────────────────────────────────────────────────────

const ORIGINAL_5EX: PlanDay = {
  day: 'Monday',
  location: 'gym',
  workoutType: 'Push',
  muscleGroups: ['Chest', 'Shoulders', 'Triceps'],
  exercises: [
    { name: 'Barbell Bench Press', sets: 4, reps: '6-10', restSeconds: 120, primaryMuscle: 'Chest', equipment: 'barbell' },
    { name: 'Incline Dumbbell Press', sets: 3, reps: '8-12', restSeconds: 90, primaryMuscle: 'Chest', equipment: 'dumbbell' },
    { name: 'Overhead Press', sets: 4, reps: '6-10', restSeconds: 120, primaryMuscle: 'Shoulders', equipment: 'barbell' },
    { name: 'Lateral Raise', sets: 3, reps: '12-15', restSeconds: 60, primaryMuscle: 'Shoulders', equipment: 'dumbbell' },
    { name: 'Tricep Pushdown', sets: 3, reps: '12-15', restSeconds: 60, primaryMuscle: 'Triceps', equipment: 'cable' },
  ],
};

const LAST_WEIGHTS = {
  'Barbell Bench Press': 80,
  'Incline Dumbbell Press': 25,
  'Overhead Press': 50,
  'Lateral Raise': 12.5,
  'Tricep Pushdown': 30,
};

// LLM dropped Lateral Raise and Tricep Pushdown, kept 3 exercises with
// reduced sets — a real-world example of the failure the guardrail exists
// to catch.
const LLM_DROPPED_TWO = {
  day: 'Monday',
  location: 'gym',
  workoutType: 'Push',
  muscleGroups: ['Chest', 'Shoulders', 'Triceps'],
  exercises: [
    { name: 'Barbell Bench Press', sets: 3, reps: '6-10', restSeconds: 120, primaryMuscle: 'Chest', equipment: 'barbell', suggestedWeightKg: 72.5 },
    { name: 'Incline Dumbbell Press', sets: 2, reps: '8-12', restSeconds: 90, primaryMuscle: 'Chest', equipment: 'dumbbell', suggestedWeightKg: 22.5 },
    { name: 'Overhead Press', sets: 3, reps: '6-10', restSeconds: 120, primaryMuscle: 'Shoulders', equipment: 'barbell', suggestedWeightKg: 45 },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────

describe('applyReplanSafety — drop guardrail at energy > 2', () => {
  it('the load-bearing case: energy 4 + LLM drops 2 exercises → all 5 restored', () => {
    // The exact bug from prod. Energy 4 must yield the original 5-exercise
    // plan. The LLM's OTHER edits (sets, weight) survive on kept exercises.
    const result = applyReplanSafety(LLM_DROPPED_TWO, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 4,
    });

    expect(result.ok).toBe(true);
    expect(result.plan).toBeDefined();
    const names = result.plan!.exercises.map(e => e.name);
    expect(names).toContain('Lateral Raise');
    expect(names).toContain('Tricep Pushdown');
    expect(result.plan!.exercises).toHaveLength(5);

    // Telemetry — restored names reported so the caller can log.
    expect(result.restored).toEqual(
      expect.arrayContaining(['Lateral Raise', 'Tricep Pushdown'])
    );
    expect(result.restored).toHaveLength(2);
  });

  it('LLM edits on KEPT exercises survive the restore path (sets, weight)', () => {
    // The LLM cut Bench from 4 → 3 sets and dropped weight to 72.5. Those
    // changes must survive; only the DROPPED exercises are restored.
    const result = applyReplanSafety(LLM_DROPPED_TWO, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 4,
    });

    const bench = result.plan!.exercises.find(e => e.name === 'Barbell Bench Press')!;
    expect(bench.sets).toBe(3); // LLM's reduction stands
    // Weight is clamped to ±1 plate of prescription, not compared exactly.
    expect(typeof bench.suggestedWeightKg).toBe('number');
  });

  it('restored exercises land in ORIGINAL index order (warm-up stays first)', () => {
    // Original order: Bench, Incline, OHP, Lateral, Pushdown.
    // LLM kept the first three; safety must slot Lateral back into position 3
    // and Pushdown into position 4 — not append them at the tail.
    const result = applyReplanSafety(LLM_DROPPED_TWO, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 4,
    });

    const names = result.plan!.exercises.map(e => e.name);
    expect(names).toEqual([
      'Barbell Bench Press',
      'Incline Dumbbell Press',
      'Overhead Press',
      'Lateral Raise',
      'Tricep Pushdown',
    ]);
  });

  it('energy 3 (neutral) is treated as > 2 — no drops allowed', () => {
    // 3 is the "normal energy" default. The prompt allows drops only at
    // "very low (1-2)", so 3 must behave the same as 4/5 — no drops.
    const result = applyReplanSafety(LLM_DROPPED_TWO, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 3,
    });
    expect(result.plan!.exercises).toHaveLength(5);
    expect(result.restored).toHaveLength(2);
  });

  it('energy 5 — no drops allowed (guardrail applies at all energy > 2)', () => {
    const result = applyReplanSafety(LLM_DROPPED_TWO, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 5,
    });
    expect(result.plan!.exercises).toHaveLength(5);
  });

  it('missing energyScore defaults to 3 (safe default — no drops)', () => {
    // Older callers that don't pass energyScore mustn't accidentally get
    // the "drops allowed" branch.
    const result = applyReplanSafety(LLM_DROPPED_TWO, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
    });
    expect(result.plan!.exercises).toHaveLength(5);
    expect(result.restored).toHaveLength(2);
  });

  it('no drops → restored is an empty array (guardrail did not fire)', () => {
    // LLM returned all 5 exercises with adjustments — the guardrail should
    // report zero restorations so telemetry stays quiet on well-behaved runs.
    const wellBehaved = {
      ...LLM_DROPPED_TWO,
      exercises: ORIGINAL_5EX.exercises.map(e => ({
        ...e,
        sets: Math.max(1, e.sets - 1), // uniform 1-set cut
      })),
    };
    const result = applyReplanSafety(wellBehaved, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 4,
    });
    expect(result.plan!.exercises).toHaveLength(5);
    expect(result.restored).toEqual([]);
  });
});

describe('applyReplanSafety — drop guardrail at energy ≤ 2 (drops allowed, floors apply)', () => {
  it('energy 2 allows dropping down to the 3-exercise floor', () => {
    // LLM dropped 2 → 3 exercises remain. At energy 2 the floor is 3 —
    // exactly at floor, no restore needed.
    const result = applyReplanSafety(LLM_DROPPED_TWO, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 2,
    });
    expect(result.plan!.exercises).toHaveLength(3);
    expect(result.restored).toEqual([]);
  });

  it('energy 1 + LLM dropped BELOW the floor → floor restored', () => {
    // LLM went nuclear and returned 1 exercise. Even at energy 1, safety
    // pads back to the MIN_EXERCISES_LOW_ENERGY floor (3), preserving
    // original order.
    const overly_aggressive = {
      ...LLM_DROPPED_TWO,
      exercises: [LLM_DROPPED_TWO.exercises[0]], // just bench
    };
    const result = applyReplanSafety(overly_aggressive, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 1,
    });
    expect(result.plan!.exercises.length).toBeGreaterThanOrEqual(3);
    expect(result.restored!.length).toBeGreaterThanOrEqual(2);
  });

  it('energy 1 + LLM dropped the WARM-UP → warm-up is restored even if floor already met', () => {
    // LLM kept 3 exercises (meets floor) but dropped the FIRST (warm-up).
    // The warm-up guarantee still forces it back to preserve session
    // opening.
    const droppedWarmup = {
      ...LLM_DROPPED_TWO,
      exercises: [
        LLM_DROPPED_TWO.exercises[1], // Incline
        LLM_DROPPED_TWO.exercises[2], // OHP
        { name: 'Lateral Raise', sets: 2, reps: '12-15', restSeconds: 60, primaryMuscle: 'Shoulders', equipment: 'dumbbell', suggestedWeightKg: 10 },
      ],
    };
    const result = applyReplanSafety(droppedWarmup, {
      original: ORIGINAL_5EX,
      lastWeights: LAST_WEIGHTS,
      energyScore: 1,
    });
    const names = result.plan!.exercises.map(e => e.name);
    expect(names[0]).toBe('Barbell Bench Press');
    expect(result.restored).toContain('Barbell Bench Press');
  });
});
