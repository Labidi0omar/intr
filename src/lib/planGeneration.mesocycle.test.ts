// Mesocycle determinism: weeks 1–4 of a block share lifts; block N+1 rotates.
//
// What this guards:
//   - Exercise selection is deterministic per (blockIndex, dayType, muscle).
//     Inside a 4-week block, every week returns the same exercises in the
//     same slot positions — that's the substrate the load-prescription coach
//     needs to accumulate per-exercise history and apply progressive overload.
//   - Across the block boundary, the seed changes, so at least one (day, slot)
//     picks a different exercise. Same-muscle variation, no whole-program reset.
//   - The production path (ensureCurrentWeekPlan generates one week at a time
//     via weeksAhead=1) matches the in-one-shot weeksAhead=4 generation for
//     the same block.
//
// We deliberately do NOT assert exact exercise names — the EXERCISES catalog
// is allowed to evolve. We assert structural identity / difference instead.

/// <reference types="node" />
import { generatePlan, type GeneratePlanArgs } from './planGeneration';

const MONDAY = new Date(2026, 5, 1); // 2026-06-01 (Mon)

function dayNames(plan: { exercises: { name: string }[] }[]): string[][] {
  return plan.map(d => d.exercises.map(e => e.name));
}

describe('mesocycle deterministic block selection', () => {
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

  const baseBro: GeneratePlanArgs = {
    fitnessLevel: 'intermediate',
    trainingDays: 5,
    location: 'gym',
    selectedDayOffsets: [0, 1, 2, 3, 4],
    blockIndex: 0,
  };

  it('weeks 1–4 of a block produce identical exercises per (day, slot)', () => {
    const plan = generatePlan({ ...baseBro, weeksAhead: 4 });
    expect(plan.length).toBe(20);

    const week1Names = dayNames(plan.slice(0, 5));
    // Sanity: every day has at least one exercise — otherwise the equality
    // assertion below could pass trivially on empty arrays.
    for (const names of week1Names) expect(names.length).toBeGreaterThan(0);

    for (let w = 1; w < 4; w++) {
      const weekNames = dayNames(plan.slice(w * 5, w * 5 + 5));
      expect(weekNames).toEqual(week1Names);
    }
  });

  it('block N+1 differs from block N for at least one (day, slot)', () => {
    const block0 = generatePlan({ ...baseBro, blockIndex: 0, weeksAhead: 1 });
    const block1 = generatePlan({ ...baseBro, blockIndex: 1, weeksAhead: 1 });

    const a = dayNames(block0).flat();
    const b = dayNames(block1).flat();
    expect(a.length).toBe(b.length);

    let differences = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences++;
    expect(differences).toBeGreaterThan(0);
  });

  it('the (workoutType, slot) rotation order from prior tests is preserved', () => {
    // Sanity-check that the deterministic shuffle didn't break the bro-split
    // template the earlier tests pin down. Same fixture as
    // planGeneration.rotation.test.ts but explicitly inside one block.
    const plan = generatePlan({ ...baseBro, weeksAhead: 4 });
    const template = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs'];
    for (let w = 0; w < 4; w++) {
      const types = plan.slice(w * 5, w * 5 + 5).map(d => d.workoutType);
      expect(types).toEqual(template);
    }
  });

  it('separate weeksAhead=1 calls within a block match the weeksAhead=4 call', () => {
    // ensureCurrentWeekPlan generates one week per call. The PRNG seed is per
    // (block, dayType, muscle) — independent of weeksAhead — so the production
    // path must yield identical lifts to a single in-one-shot block call.
    const allAtOnce = generatePlan({ ...baseBro, weeksAhead: 4 });
    const week1FromBlock = dayNames(allAtOnce.slice(0, 5));

    // bro_split is rotation:'fixed' so dayIndexOffset doesn't affect dayType
    // selection — every weeksAhead=1 call independently lays out the same
    // chest/back/shoulders/arms/legs template. The PRNG is keyed on dayType,
    // not on the global day counter, so picks match.
    const week1Solo = generatePlan({ ...baseBro, weeksAhead: 1, dayIndexOffset: 0 });
    expect(dayNames(week1Solo)).toEqual(week1FromBlock);

    const week2Solo = generatePlan({
      ...baseBro,
      weeksAhead: 1,
      dayIndexOffset: 5,
      startDate: '2026-06-08',
    });
    expect(dayNames(week2Solo)).toEqual(week1FromBlock);
  });

  it('ppl: weeks within a block match per (workoutType, slot)', () => {
    // For cycling rotations the dayType ordering depends on dayIndexOffset, so
    // the cross-week equality is "same exercises for the same workoutType",
    // not "same exercises in the same array slot". This mirrors how a real
    // user's Monday-Push of week 1 should equal Monday-Push of week 4.
    const plan = generatePlan({
      fitnessLevel: 'intermediate',
      trainingDays: 3,
      location: 'gym',
      selectedDayOffsets: [0, 2, 4],
      blockIndex: 0,
      weeksAhead: 4,
    });
    expect(plan.length).toBe(12);

    // Group exercise-name arrays by workoutType, keep only the first
    // occurrence per (workoutType, week) — then assert weeks 2–4 match week 1.
    const byTypeByWeek: Record<string, string[][]> = {};
    for (let w = 0; w < 4; w++) {
      for (let i = 0; i < 3; i++) {
        const d = plan[w * 3 + i];
        (byTypeByWeek[d.workoutType] ||= []).push(d.exercises.map(e => e.name));
      }
    }
    for (const [, weeks] of Object.entries(byTypeByWeek)) {
      expect(weeks.length).toBe(4);
      for (let w = 1; w < 4; w++) expect(weeks[w]).toEqual(weeks[0]);
    }
  });
});
