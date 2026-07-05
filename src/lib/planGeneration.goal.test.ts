/// <reference types="node" />
// Goal-aware generation — confirms `profiles.goal` (via GeneratePlanArgs.goal)
// actually re-doses the emitted plan without touching exercise selection,
// day types, or dates.
//
// Two lanes with the same schedule must produce identical LIFTS but different
// reps / rest / sets — that's the whole point of the feature. If this file
// ever passes with strength === muscle output, the wiring in generatePlan is
// broken.

import { generatePlan, type GeneratePlanArgs } from './planGeneration';

const MONDAY = new Date(2026, 5, 1); // 2026-06-01 (Mon)

const base: Omit<GeneratePlanArgs, 'goal'> = {
  fitnessLevel: 'intermediate',
  trainingDays: 5,
  location: 'gym',
  split: 'bro_split',
  selectedDayOffsets: [0, 1, 2, 3, 4],
  blockIndex: 0,
  blockWeek: 1,
};

describe('goal-aware plan generation', () => {
  let realDate: DateConstructor;

  beforeAll(() => {
    realDate = global.Date;
    class MockDate extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) { super(MONDAY.getTime()); return; }
        // @ts-ignore
        super(...args);
      }
      static now() { return MONDAY.getTime(); }
    }
    // @ts-ignore
    global.Date = MockDate;
  });

  afterAll(() => { global.Date = realDate; });

  it('two lanes with the same schedule share the PRIMARY compound per muscle (progression anchor)', () => {
    // The seeded picker keys on (blockIndex, dayType, muscle), NOT on goal,
    // so the top-ranked compound per muscle is the same across lanes — the
    // load-progression substrate the mesocycle contract needs. What LEGITIMATELY
    // differs across lanes is the ACCESSORY TAIL: strength's tighter caps
    // (20 sets / 6 movements) force a more aggressive trim than muscle's
    // (25 sets / 8 movements), so a high-volume day like legs may end up
    // with fewer accessories on the strength lane. That's the whole point
    // of the rules engine — the two lanes structure differently.
    //
    // The invariant that survives: within each muscle group, the FIRST
    // exercise (the compound anchor / primary progression lift) is the
    // same on both lanes. That's what load-prescription history reads.
    const strength = generatePlan({ ...base, goal: 'strength' });
    const muscle = generatePlan({ ...base, goal: 'muscle' });
    expect(strength.length).toBe(muscle.length);
    for (let d = 0; d < strength.length; d++) {
      // Group exercises by their primaryMuscle label — the first exercise
      // in each group is the compound anchor (compounds sorted first by
      // classifyCompoundness within each muscle).
      const firstByMuscle = (day: (typeof strength)[number]) => {
        const seen: Record<string, string> = {};
        for (const ex of day.exercises) {
          if (!seen[ex.primaryMuscle]) seen[ex.primaryMuscle] = ex.name;
        }
        return seen;
      };
      const sMap = firstByMuscle(strength[d]);
      const mMap = firstByMuscle(muscle[d]);
      // Every muscle trained on BOTH lanes shares its anchor exercise.
      for (const key of Object.keys(sMap)) {
        if (mMap[key]) expect(sMap[key]).toBe(mMap[key]);
      }
    }
  });

  it('within-lane mesocycle stability: weeks 1-3 of a block return identical exercises (both lanes)', () => {
    // The real determinism contract — the substrate load-progression relies
    // on. Within a lane and a block, weeks 1, 2, 3 produce byte-identical
    // exercise NAMES (only sets vary with the ramp).
    for (const goal of ['strength', 'muscle'] as const) {
      const wk1 = generatePlan({ ...base, goal, blockWeek: 1 });
      const wk2 = generatePlan({ ...base, goal, blockWeek: 2 });
      const wk3 = generatePlan({ ...base, goal, blockWeek: 3 });
      for (let d = 0; d < wk1.length; d++) {
        const n1 = wk1[d].exercises.map(e => e.name);
        const n2 = wk2[d].exercises.map(e => e.name);
        const n3 = wk3[d].exercises.map(e => e.name);
        expect(n2).toEqual(n1);
        expect(n3).toEqual(n1);
      }
    }
  });

  it('strength emits low-rep compound + longer rest', () => {
    const plan = generatePlan({ ...base, goal: 'strength' });
    for (const day of plan) {
      for (const ex of day.exercises) {
        // Chest day includes Barbell Bench Press (compound). Sample the
        // compound and confirm strength's 3-5 / 210s dose landed.
        if (ex.name === 'Barbell Bench Press') {
          expect(ex.reps).toBe('3-5');
          expect(ex.restSeconds).toBe(210);
        }
        if (ex.name === 'Lateral Raise') {
          // Strength isolation is 8-10 (tuned from 6-8 to protect elbows /
          // shoulders on curls, raises, extensions).
          expect(ex.reps).toBe('8-10');
          expect(ex.restSeconds).toBe(120);
        }
      }
    }
  });

  it('muscle emits high-rep compound + shorter rest', () => {
    const plan = generatePlan({ ...base, goal: 'muscle' });
    for (const day of plan) {
      for (const ex of day.exercises) {
        if (ex.name === 'Barbell Bench Press') {
          expect(ex.reps).toBe('6-10');
          expect(ex.restSeconds).toBe(120);
        }
        if (ex.name === 'Lateral Raise') {
          expect(ex.reps).toBe('10-15');
          expect(ex.restSeconds).toBe(75);
        }
      }
    }
  });

  it('general is a pure passthrough — catalog reps / rest flow through unchanged', () => {
    // Existing / default users see NO change on the general lane. Catalog
    // values (bench 8-12 / 90s, lateral raise 12-15 / 60s) reach the plan
    // unmodified — that's the whole point of the passthrough contract.
    const plan = generatePlan({ ...base, goal: 'general' });
    for (const day of plan) {
      for (const ex of day.exercises) {
        if (ex.name === 'Barbell Bench Press') {
          expect(ex.reps).toBe('8-12');
          expect(ex.restSeconds).toBe(90);
        }
        if (ex.name === 'Lateral Raise') {
          expect(ex.reps).toBe('12-15');
          expect(ex.restSeconds).toBe(60);
        }
      }
    }
  });

  it('omitting goal leaves reps/rest/sets untouched (back-compat)', () => {
    const withoutGoal = generatePlan({ ...base });
    for (const day of withoutGoal) {
      for (const ex of day.exercises) {
        // Barbell Bench Press catalog value is 8-12 / 90s / 4 sets.
        if (ex.name === 'Barbell Bench Press') {
          expect(ex.reps).toBe('8-12');
          expect(ex.restSeconds).toBe(90);
        }
      }
    }
  });

  it('muscle isolation gains +1 set in weeks 2 and 3 (volume-first progression)', () => {
    const wk1 = generatePlan({ ...base, goal: 'muscle', blockWeek: 1 });
    const wk2 = generatePlan({ ...base, goal: 'muscle', blockWeek: 2 });
    const wk3 = generatePlan({ ...base, goal: 'muscle', blockWeek: 3 });

    const findLateral = (plan: ReturnType<typeof generatePlan>) => {
      for (const day of plan) {
        const lat = day.exercises.find(e => e.name === 'Lateral Raise');
        if (lat) return lat;
      }
      return null;
    };
    const l1 = findLateral(wk1);
    const l2 = findLateral(wk2);
    const l3 = findLateral(wk3);
    expect(l1).not.toBeNull();
    expect(l2).not.toBeNull();
    expect(l3).not.toBeNull();
    // Catalog default is 3 sets. Muscle isolation should climb.
    expect(l2!.sets).toBe(l1!.sets + 1);
    expect(l3!.sets).toBe(l1!.sets + 1);
  });

  it('strength isolation sets stay FLAT across weeks 1-3 (progression is load only)', () => {
    const wk1 = generatePlan({ ...base, goal: 'strength', blockWeek: 1 });
    const wk2 = generatePlan({ ...base, goal: 'strength', blockWeek: 2 });
    const wk3 = generatePlan({ ...base, goal: 'strength', blockWeek: 3 });

    for (let d = 0; d < wk1.length; d++) {
      const s1 = wk1[d].exercises.map(e => e.sets);
      const s2 = wk2[d].exercises.map(e => e.sets);
      const s3 = wk3[d].exercises.map(e => e.sets);
      expect(s2).toEqual(s1);
      expect(s3).toEqual(s1);
    }
  });

  it('deload week still lightens on top of the goal dose (goal → deload stack)', () => {
    // Week 4 of a strength block: goal reps are 3-5; deload adds +2 → 5-7.
    // Sets scale down via deloadSets on the goal-set baseline.
    const wk1 = generatePlan({ ...base, goal: 'strength', blockWeek: 1 });
    const wk4 = generatePlan({ ...base, goal: 'strength', blockWeek: 4 });

    const findBench = (plan: ReturnType<typeof generatePlan>) => {
      for (const day of plan) {
        const b = day.exercises.find(e => e.name === 'Barbell Bench Press');
        if (b) return b;
      }
      return null;
    };
    const b1 = findBench(wk1);
    const b4 = findBench(wk4);
    expect(b1).not.toBeNull();
    expect(b4).not.toBeNull();
    // Strength wk1 reps: 3-5. Deload adds +2 to each end: 5-7.
    expect(b1!.reps).toBe('3-5');
    expect(b4!.reps).toBe('5-7');
    // Deload week is stamped so the coach can back off aggressive copy.
    expect(wk4[0].deload).toBe(true);
    expect(wk1[0].deload).not.toBe(true);
  });
});
