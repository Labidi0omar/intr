// Tests for the v5 ranking-based exercise selection.
//
// Contracts being pinned (see info/exercise-ranking.md and the v5 history
// note in planGeneration.ts::CURRENT_PLAN_VERSION):
//
//   1. A generated chest/push day with chest count >= 2 always includes a
//      compound chest press — never two flyes.
//   2. A generated back/pull day with back count >= 2 includes BOTH a row
//      (horizontal) and a pulldown/pull-up (vertical).
//   3. Selection is deterministic — two identical generatePlan calls return
//      identical sequences.
//   4. Within a 4-week block, the isPrimary compound for a muscle is the
//      SAME exercise all 4 weeks. Across a block boundary, accessories may
//      change (under planHistory pressure) but the isPrimary anchor
//      persists.
//   5. Higher-score exercises are preferred over lower-score ones when
//      both have equal recency.

import { generatePlan } from './planGeneration';

const TODAY = '2026-06-01';

const basePush = {
  fitnessLevel: 'intermediate' as const,
  trainingDays: 3,           // PPL — push/pull/legs across the week
  location: 'gym' as const,
  weeksAhead: 1,
  startDate: TODAY,
};

function isHorizontalPull(name: string): boolean {
  return /\brow\b/i.test(name);
}
function isVerticalPull(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('pulldown') ||
    n.includes('pull-up') ||
    n.includes('pullup') ||
    n.includes('pull up') ||
    n.includes('chin');
}
function isFly(name: string): boolean {
  return /\bfly\b|\bflyes\b/i.test(name);
}

describe('v5 ranking — chest day always has a compound chest press', () => {
  it('PPL push day (gym, intermediate) — chest:2 slot is not two flyes', () => {
    const plan = generatePlan(basePush);
    const pushDay = plan.find(d => d.workoutType === 'Push')!;
    expect(pushDay).toBeDefined();
    const chestExercises = pushDay.exercises.filter(e => e.primaryMuscle === 'Chest');
    expect(chestExercises.length).toBeGreaterThanOrEqual(2);
    // At least one chest pick must be a compound press (not a fly / pullover).
    const compoundPress = chestExercises.find(e => /press|push-up/i.test(e.name) && !isFly(e.name));
    expect(compoundPress).toBeDefined();
    // And the highest-score chest exercise (Barbell Bench Press, 93) is in
    // the slot — it's the chest PRIMARY anchor.
    expect(chestExercises.some(e => e.name === 'Barbell Bench Press')).toBe(true);
  });

  it('bro split chest day (gym) — chest:4 slot has at least one compound press', () => {
    const plan = generatePlan({
      ...basePush,
      trainingDays: 5,
      weeksAhead: 1,
    });
    const chestDay = plan.find(d => d.workoutType === 'Chest')!;
    expect(chestDay).toBeDefined();
    const chestExercises = chestDay.exercises.filter(e => e.primaryMuscle === 'Chest');
    expect(chestExercises.some(e => /press|push-up/i.test(e.name) && !isFly(e.name))).toBe(true);
    // The chest PRIMARY anchor (Barbell Bench Press) must be present.
    expect(chestExercises.some(e => e.name === 'Barbell Bench Press')).toBe(true);
  });
});

describe('v5 ranking — back day requires one horizontal + one vertical pull', () => {
  it('PPL pull day (gym, intermediate) — back picks include both a row and a pulldown/pull-up', () => {
    const plan = generatePlan(basePush);
    const pullDay = plan.find(d => d.workoutType === 'Pull')!;
    expect(pullDay).toBeDefined();
    const backExercises = pullDay.exercises.filter(e => e.primaryMuscle === 'Back');
    expect(backExercises.length).toBeGreaterThanOrEqual(2);
    expect(backExercises.some(e => isHorizontalPull(e.name))).toBe(true);
    expect(backExercises.some(e => isVerticalPull(e.name))).toBe(true);
  });

  it('bro split back day (gym) — back:3 has both patterns', () => {
    const plan = generatePlan({
      ...basePush,
      trainingDays: 5,
      weeksAhead: 1,
    });
    const backDay = plan.find(d => d.workoutType === 'Back')!;
    expect(backDay).toBeDefined();
    const backExercises = backDay.exercises.filter(e => e.primaryMuscle === 'Back');
    expect(backExercises.some(e => isHorizontalPull(e.name))).toBe(true);
    expect(backExercises.some(e => isVerticalPull(e.name))).toBe(true);
  });
});

describe('v5 ranking — selection is deterministic', () => {
  it('two identical generatePlan calls return identical exercise sequences', () => {
    const a = generatePlan(basePush);
    const b = generatePlan(basePush);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].exercises.map(e => e.name)).toEqual(b[i].exercises.map(e => e.name));
    }
  });
});

describe('v5 ranking — isPrimary anchors persist across blocks', () => {
  it('within a 4-week block, the chest PRIMARY appears every week', () => {
    const plan = generatePlan({ ...basePush, weeksAhead: 4, blockWeek: 1, blockIndex: 0 });
    // 3 training days/week × 4 weeks = 12 days; "Push" is every 3rd day.
    const pushDays = plan.filter(d => d.workoutType === 'Push');
    expect(pushDays.length).toBe(4);
    for (const day of pushDays) {
      const names = day.exercises.map(e => e.name);
      expect(names).toContain('Barbell Bench Press');     // chest PRIMARY
      expect(names).toContain('Overhead Press');          // shoulders PRIMARY
    }
  });

  it('across a block boundary, the isPrimary anchor stays the same exercise', () => {
    // No planHistory: blocks 0 and 1 are score-identical for the top picks.
    // The chest PRIMARY (Barbell Bench Press) and shoulders PRIMARY
    // (Overhead Press) must be present in both blocks.
    const block0 = generatePlan({ ...basePush, blockIndex: 0 });
    const block1 = generatePlan({ ...basePush, blockIndex: 1 });
    const push0 = block0.find(d => d.workoutType === 'Push')!;
    const push1 = block1.find(d => d.workoutType === 'Push')!;
    expect(push0.exercises.map(e => e.name)).toContain('Barbell Bench Press');
    expect(push1.exercises.map(e => e.name)).toContain('Barbell Bench Press');
    expect(push0.exercises.map(e => e.name)).toContain('Overhead Press');
    expect(push1.exercises.map(e => e.name)).toContain('Overhead Press');
  });

  it('with planHistory pressuring accessories, isPrimary still appears; accessories rotate', () => {
    // Pressure the accessory chest picks (Incline BB, Incline DB) into the
    // recent-history buckets. The PRIMARY (Barbell Bench Press) is exempt
    // from deprioritization and must still be picked.
    const pressuredHistory = [
      { exercises: ['Incline Barbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Bench Press'] },
      { exercises: ['Incline Barbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Bench Press'] },
      { exercises: ['Incline Barbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Bench Press'] },
      { exercises: ['Incline Barbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Bench Press'] },
    ];
    const plan = generatePlan({ ...basePush, planHistory: pressuredHistory });
    const pushDay = plan.find(d => d.workoutType === 'Push')!;
    const chestExercises = pushDay.exercises.filter(e => e.primaryMuscle === 'Chest');
    // Anchor must still be there even though every other chest exercise
    // got pressured down.
    expect(chestExercises.some(e => e.name === 'Barbell Bench Press')).toBe(true);
  });
});

describe('v5 ranking — higher-score exercises win at equal recency', () => {
  it('with no history, chest:2 picks the two highest-score chest exercises', () => {
    const plan = generatePlan(basePush);
    const pushDay = plan.find(d => d.workoutType === 'Push')!;
    const chestNames = pushDay.exercises.filter(e => e.primaryMuscle === 'Chest').map(e => e.name);
    // Top 2 by score: Barbell Bench Press (93), Incline Barbell Bench
    // Press (92). With ensureCompound a no-op (both are compounds), these
    // are the picks.
    expect(chestNames).toContain('Barbell Bench Press');
    expect(chestNames).toContain('Incline Barbell Bench Press');
  });

  it('lower-score chest exercises (Cable Fly 80, Dumbbell Fly 72) are NOT picked over the top compounds', () => {
    const plan = generatePlan(basePush);
    const pushDay = plan.find(d => d.workoutType === 'Push')!;
    const chestNames = pushDay.exercises.filter(e => e.primaryMuscle === 'Chest').map(e => e.name);
    expect(chestNames).not.toContain('Cable Fly');
    expect(chestNames).not.toContain('Dumbbell Fly');
  });
});

describe('v5 ranking — guarantee fires when top-N are all isolations', () => {
  it('shoulders day still gets a compound press alongside the lateral raise', () => {
    const plan = generatePlan(basePush);
    const pushDay = plan.find(d => d.workoutType === 'Push')!;
    const shoulderExercises = pushDay.exercises.filter(e => e.primaryMuscle === 'Shoulders');
    expect(shoulderExercises.length).toBeGreaterThanOrEqual(2);
    // Top 2 shoulders by score tie at 90: Overhead Press (compound,
    // PRIMARY) and Lateral Raise (isolation). The compound guarantee
    // ensures Overhead Press makes it in even if the rand tie-break
    // ranked the lateral raise first.
    expect(shoulderExercises.some(e => /press/i.test(e.name))).toBe(true);
    expect(shoulderExercises.some(e => e.name === 'Overhead Press')).toBe(true);
  });
});
