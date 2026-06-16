// The split is now an EXPLICIT user choice (profiles.preferred_split), not a
// function of training_days. So generatePlan must:
//   - honor an explicit `split` over the days-derived default,
//   - fall back to splitForDays(days) when none/garbage is given (resolveSplit),
//   - produce a sane plan for ANY split×days combo the user can now pick
//     (e.g. bro_split with 2 days, full_body with 6) — no crash, no empty days,
//     exactly trainingDays sessions, all on distinct calendar dates.

import { generatePlan, resolveSplit, splitForDays, type SplitId } from './planGeneration';

const BASE = {
  fitnessLevel: 'intermediate' as const,
  location: 'gym' as const,
  startDate: '2026-06-15', // Monday — fixed for deterministic dates
};

function types(days: { workoutType: string }[]): string[] {
  return days.map(d => d.workoutType);
}

describe('resolveSplit', () => {
  it('returns the explicit split when it is a real split id', () => {
    for (const s of ['full_body', 'upper_lower', 'ppl', 'bro_split'] as SplitId[]) {
      expect(resolveSplit(s, 3)).toBe(s);
    }
  });

  it('falls back to splitForDays when the split is missing or garbage', () => {
    expect(resolveSplit(undefined, 2)).toBe('upper_lower');
    expect(resolveSplit(null, 3)).toBe('ppl');
    expect(resolveSplit('nonsense' as unknown as SplitId, 5)).toBe('bro_split');
  });
});

describe('generatePlan — explicit split drives generation', () => {
  it('honors the explicit split over the days-derived default', () => {
    // 3 days would default to ppl, but the user picked bro_split.
    const days = generatePlan({ ...BASE, trainingDays: 3, split: 'bro_split' });
    expect(types(days)).toEqual(['Chest', 'Back', 'Shoulders']);
  });

  it('falls back to splitForDays(days) when no split is passed (backward compatible)', () => {
    const d3 = generatePlan({ ...BASE, trainingDays: 3 }); // → ppl
    expect(types(d3)).toEqual(['Push', 'Pull', 'Legs']);
    const d2 = generatePlan({ ...BASE, trainingDays: 2 }); // → upper_lower
    expect(types(d2)).toEqual(['Upper', 'Lower']);
  });

  it('a garbage split never crashes — it falls back to the days default', () => {
    const days = generatePlan({ ...BASE, trainingDays: 4, split: 'bogus' as unknown as SplitId });
    expect(types(days)).toEqual(['Push', 'Pull', 'Legs', 'Push']); // ppl @ 4
  });
});

describe('generatePlan — off-nominal split×days combos are sane', () => {
  // Every case: exactly `trainingDays` sessions, distinct dates (no
  // duplicate-day artifacts), every day has at least one exercise (no empty
  // days), and the workout types are the expected rotation for that split.
  const cases: { split: SplitId; days: number; expected: string[] }[] = [
    { split: 'bro_split', days: 2, expected: ['Chest', 'Back'] },
    { split: 'full_body', days: 6, expected: ['Full Body', 'Full Body', 'Full Body', 'Full Body', 'Full Body', 'Full Body'] },
    { split: 'upper_lower', days: 5, expected: ['Upper', 'Lower', 'Upper', 'Lower', 'Upper'] },
    { split: 'ppl', days: 6, expected: ['Push', 'Pull', 'Legs', 'Push', 'Pull', 'Legs'] },
    { split: 'bro_split', days: 6, expected: ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Arms'] },
    { split: 'full_body', days: 2, expected: ['Full Body', 'Full Body'] },
  ];

  for (const { split, days, expected } of cases) {
    it(`${split} × ${days} days → valid plan, no crash/empty/dup`, () => {
      const plan = generatePlan({ ...BASE, trainingDays: days, split });

      // Exactly one session per training day.
      expect(plan).toHaveLength(days);

      // No duplicate-day artifacts: every session is on a distinct date.
      const dates = plan.map(d => d.date);
      expect(new Set(dates).size).toBe(days);

      // No empty days — each session has real exercises.
      for (const d of plan) {
        expect(Array.isArray(d.exercises)).toBe(true);
        expect(d.exercises.length).toBeGreaterThan(0);
        expect(typeof d.workoutType).toBe('string');
        expect(d.workoutType.length).toBeGreaterThan(0);
      }

      // Correct rotation for the chosen split at this day count.
      expect(types(plan)).toEqual(expected);
    });
  }

  it('deterministic: same args → same plan', () => {
    const a = generatePlan({ ...BASE, trainingDays: 2, split: 'bro_split' });
    const b = generatePlan({ ...BASE, trainingDays: 2, split: 'bro_split' });
    expect(b).toEqual(a);
  });
});

describe('splitForDays default mapping is unchanged', () => {
  it('still maps day counts to the documented defaults', () => {
    expect(splitForDays(1)).toBe('full_body');
    expect(splitForDays(2)).toBe('upper_lower');
    expect(splitForDays(3)).toBe('ppl');
    expect(splitForDays(4)).toBe('ppl');
    expect(splitForDays(5)).toBe('bro_split');
    expect(splitForDays(6)).toBe('bro_split');
  });
});
