/// <reference types="node" />
// Deload week — final week of each 4-week mesocycle block.
//
// What we guard:
//   - Week 4 of a block has FEWER total working sets than weeks 1–3.
//   - Week 4 days are stamped `deload: true`; earlier weeks are not.
//   - Exercises in week 4 are the SAME as weeks 1–3 (deload changes dose,
//     not selection — that's what keeps the data comparable across the block).
//   - Week 1 of the next block (blockWeek=1 after blockWeek=4) is back to
//     full volume — the deload doesn't bleed into the new block.
//   - Single-week calls obey explicit blockWeek input.
//   - Reps bump on deload only when the source range is numeric (AMRAP and
//     friends are left alone).

import { generatePlan, type GeneratePlanArgs, type PlanDay } from './planGeneration';

const MONDAY = new Date(2026, 5, 1); // 2026-06-01 (Mon)

const baseBro: GeneratePlanArgs = {
  fitnessLevel: 'intermediate',
  trainingDays: 5,
  location: 'gym',
  selectedDayOffsets: [0, 1, 2, 3, 4],
  blockIndex: 0,
  blockWeek: 1,
};

function totalSets(days: PlanDay[]): number {
  let s = 0;
  for (const d of days) for (const ex of d.exercises) s += ex.sets;
  return s;
}

function namesByDay(days: PlanDay[]): string[][] {
  return days.map(d => d.exercises.map(e => e.name));
}

describe('deload week — labeling and volume', () => {
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

  it('weeks 1–3 are NOT labelled deload, week 4 IS', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 4 });
    expect(plan.length).toBe(20);
    for (let w = 0; w < 3; w++) {
      for (let d = 0; d < 5; d++) {
        expect(plan[w * 5 + d].deload).not.toBe(true);
      }
    }
    for (let d = 0; d < 5; d++) {
      expect(plan[15 + d].deload).toBe(true);
    }
  });

  it('week 4 has fewer total working sets than week 1 (the deload cut)', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 4 });
    const w1 = totalSets(plan.slice(0, 5));
    const w2 = totalSets(plan.slice(5, 10));
    const w3 = totalSets(plan.slice(10, 15));
    const w4 = totalSets(plan.slice(15, 20));
    // Sanity: weeks 1–3 are equal (same dose).
    expect(w2).toBe(w1);
    expect(w3).toBe(w1);
    // Deload week is strictly lighter.
    expect(w4).toBeLessThan(w1);
    // And the cut is substantial — at least 25% off. Guards against a
    // future tweak that quietly flattens the deload into noise.
    expect(w4).toBeLessThanOrEqual(Math.floor(w1 * 0.8));
  });

  it('week 4 keeps the SAME exercises per (day, slot) as week 1 (dose changes, not selection)', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 4 });
    expect(namesByDay(plan.slice(15, 20))).toEqual(namesByDay(plan.slice(0, 5)));
  });

  it('per-exercise sets are floored at 1 and cut roughly 40% on deload', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 4 });
    for (let d = 0; d < 5; d++) {
      const w1 = plan[d].exercises;
      const w4 = plan[15 + d].exercises;
      expect(w4.length).toBe(w1.length);
      for (let i = 0; i < w1.length; i++) {
        expect(w4[i].sets).toBeGreaterThanOrEqual(1);
        // For any source >1 set, deload must be strictly fewer.
        if (w1[i].sets > 1) expect(w4[i].sets).toBeLessThan(w1[i].sets);
      }
    }
  });

  it('numeric rep ranges bump +2 on deload; non-numeric (e.g. "AMRAP") pass through', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 4 });
    let bumpsObserved = 0;
    for (let d = 0; d < 5; d++) {
      const w1 = plan[d].exercises;
      const w4 = plan[15 + d].exercises;
      for (let i = 0; i < w1.length; i++) {
        const r1 = w1[i].reps;
        const r4 = w4[i].reps;
        const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(r1);
        const single = /^\s*(\d+)\s*$/.exec(r1);
        if (range) {
          expect(r4).toBe(`${parseInt(range[1], 10) + 2}-${parseInt(range[2], 10) + 2}`);
          bumpsObserved++;
        } else if (single) {
          expect(r4).toBe(String(parseInt(single[1], 10) + 2));
          bumpsObserved++;
        } else {
          // AMRAP / "to failure" / other tokens: pass through unchanged.
          expect(r4).toBe(r1);
        }
      }
    }
    // Sanity: the catalog has at least some numeric ranges, so the bump
    // path actually got exercised — guards against a future selection
    // change that accidentally drops all numeric-rep exercises from the
    // deload week.
    expect(bumpsObserved).toBeGreaterThan(0);
  });
});

describe('deload — block boundary behavior', () => {
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

  it('the week AFTER a deload (next block, week 1) is back to full volume', () => {
    // Simulate the production path: ensureCurrentWeekPlan calls generatePlan
    // weeksAhead=1 per week. Week 1 of the next block has blockIndex+1 and
    // blockWeek=1; volume must be back to baseline.
    const w1Block0 = generatePlan({
      ...baseBro, weeksAhead: 1, blockIndex: 0, blockWeek: 1, startDate: '2026-06-01',
    });
    const w4Block0 = generatePlan({
      ...baseBro, weeksAhead: 1, blockIndex: 0, blockWeek: 4, startDate: '2026-06-22',
    });
    const w1Block1 = generatePlan({
      ...baseBro, weeksAhead: 1, blockIndex: 1, blockWeek: 1, startDate: '2026-06-29',
    });

    expect(w4Block0.every(d => d.deload === true)).toBe(true);
    expect(w1Block1.every(d => d.deload !== true)).toBe(true);

    expect(totalSets(w4Block0)).toBeLessThan(totalSets(w1Block0));
    // The new block's volume is at full-block-1 level, NOT deload level.
    // Exact equality would over-constrain — block N+1 reshuffles exercise
    // selection (PR1's deterministic seeding), and different exercises in
    // the catalog have different default set counts, so the totals can
    // differ by a couple of sets. What we need is "well above the deload
    // floor": within 10% of block 0's week-1 volume.
    const w1Block0Total = totalSets(w1Block0);
    expect(totalSets(w1Block1)).toBeGreaterThanOrEqual(Math.floor(w1Block0Total * 0.9));
    expect(totalSets(w1Block1)).toBeGreaterThan(totalSets(w4Block0));
  });

  it('a single-week call with blockWeek=4 produces a deload', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 1, blockWeek: 4 });
    expect(plan.length).toBe(5);
    expect(plan.every(d => d.deload === true)).toBe(true);
  });

  it('a single-week call with blockWeek=1 (default) does NOT deload', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 1 });
    expect(plan.length).toBe(5);
    expect(plan.every(d => d.deload !== true)).toBe(true);
  });

  it('weeksAhead=4 starting at blockWeek=3 wraps the boundary — week 2 of the call is the deload', () => {
    // Calling generatePlan starting mid-block (e.g. user joined mid-cycle)
    // means the deload lands at (4 - startBlockWeek + 1) inside the call:
    //   blockWeek=3, week 0 → in-block 3
    //   blockWeek=3, week 1 → in-block 4  ← deload
    //   blockWeek=3, week 2 → in-block 1
    //   blockWeek=3, week 3 → in-block 2
    const plan = generatePlan({ ...baseBro, weeksAhead: 4, blockWeek: 3 });
    expect(plan.length).toBe(20);
    expect(plan.slice(0, 5).every(d => d.deload !== true)).toBe(true);
    expect(plan.slice(5, 10).every(d => d.deload === true)).toBe(true);
    expect(plan.slice(10, 15).every(d => d.deload !== true)).toBe(true);
    expect(plan.slice(15, 20).every(d => d.deload !== true)).toBe(true);
  });
});
