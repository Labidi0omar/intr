// Regression tests for the 'fixed' rotation (bro_split).
// History of this bug:
//   - Originally globalI was a continuous multi-week counter, so once
//     globalI >= dayTypes.length (5) every training day fell into dropOrder
//     and only arms/shoulders were emitted forever (the "collapse").
//   - The first fix wrapped dayTypes by globalI % dayTypes.length. That
//     stopped the collapse but DRIFTED the weekly phase: with 6 training
//     days, globalI advanced 6/week, so each week started one slot later
//     (week2=back, week3=shoulders...) and the calendar spliced the drifting
//     weeks into a chest-less, arms-heavy mess.
//   - Current behavior: a 'fixed' split is a STABLE WEEKLY TEMPLATE keyed on
//     the in-week index, so every week is the identical assignment. dropOrder
//     supplies the extra day(s) only when trainingDays > dayTypes.length.

/// <reference types="node" />
import { generatePlan } from './planGeneration';

const MONDAY = new Date(2026, 5, 1); // 2026-06-01 (Mon) — month is 0-indexed

describe('bro_split multi-week rotation', () => {
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

  it('5-day bro split is the SAME stable template every week across 4 weeks', () => {
    const plan = generatePlan({
      fitnessLevel: 'intermediate',
      trainingDays: 5,
      location: 'gym',
      weeksAhead: 4,
      selectedDayOffsets: [0, 1, 2, 3, 4],
    });

    expect(plan.length).toBe(20);

    // Every week must be the identical ordered assignment — no phase drift.
    const template = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs'];
    for (let w = 0; w < 4; w++) {
      const week = plan.slice(w * 5, w * 5 + 5).map(d => d.workoutType);
      expect(week).toEqual(template);
    }
  });

  it('6-day bro split repeats a stable template (5 groups + dropOrder arms) every week', () => {
    const plan = generatePlan({
      fitnessLevel: 'intermediate',
      trainingDays: 6,
      location: 'gym',
      weeksAhead: 3,
      selectedDayOffsets: [0, 1, 2, 3, 4, 5],
    });

    expect(plan.length).toBe(18);

    // dropOrder[0] = 'arms' → label 'Arms' as the 6th day; identical every week.
    const template = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Arms'];
    for (let w = 0; w < 3; w++) {
      const week = plan.slice(w * 6, w * 6 + 6).map(d => d.workoutType);
      expect(week).toEqual(template);
    }
  });

  it('upper_lower keeps alternating across multi-week generation', () => {
    const plan = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 4,
      location: 'gym',
      weeksAhead: 3,
      selectedDayOffsets: [0, 2, 4, 6],
    });
    // 4 days * 3 weeks = 12 entries, strictly alternating upper/lower.
    expect(plan.length).toBe(12);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].workoutType).not.toBe(plan[i - 1].workoutType);
    }
  });

  it('ppl keeps cycling push→pull→legs across multi-week generation', () => {
    const plan = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 3,
      location: 'gym',
      weeksAhead: 3,
      selectedDayOffsets: [0, 2, 4],
    });
    const seq = plan.map(d => d.workoutType);
    expect(seq).toEqual([
      'Push', 'Pull', 'Legs',
      'Push', 'Pull', 'Legs',
      'Push', 'Pull', 'Legs',
    ]);
  });
});
