/// <reference types="node" />
// dashboardStats.ts module-imports the supabase client, which transitively
// requires react-native (not transformed by this project's jest setup).
// Mock both before SUT import so the pure-logic tests below can run.
jest.mock('../lib/supabase', () => ({ supabase: {} }));

import {
  computeEffortZoneFromLogs,
  computeStrengthTrendFromLogs,
  parseWeightKg,
  formatStrengthTrend,
  type ExerciseLogRow,
} from './dashboardStats';

const TODAY = new Date(2026, 5, 1); // 2026-06-01 (pin for stable windows)

function iso(daysAgo: number): string {
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('parseWeightKg', () => {
  it('accepts numbers and numeric strings', () => {
    expect(parseWeightKg(100)).toBe(100);
    expect(parseWeightKg('80.5')).toBe(80.5);
  });
  it('rejects bodyweight tokens and junk', () => {
    expect(parseWeightKg('bw')).toBeNull();
    expect(parseWeightKg('BW')).toBeNull();
    expect(parseWeightKg('bodyweight')).toBeNull();
    expect(parseWeightKg('')).toBeNull();
    expect(parseWeightKg(null)).toBeNull();
    expect(parseWeightKg(undefined as any)).toBeNull();
    expect(parseWeightKg('n/a')).toBeNull();
    expect(parseWeightKg(NaN)).toBeNull();
  });
});

describe('computeEffortZoneFromLogs', () => {
  it('counts only rated sets (reps_in_reserve != null), most recent N', () => {
    const logs: ExerciseLogRow[] = [
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 5, logged_date: iso(40) }, // out of zone, but older
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: null, logged_date: iso(2) }, // unrated, ignored
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 1, logged_date: iso(1) }, // hit
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(0) }, // hit
    ];
    const r = computeEffortZoneFromLogs(logs);
    expect(r).toEqual({ hits: 2, total: 3 });
  });
  it('returns total=0 when no rated sets exist (callers render "—")', () => {
    const logs: ExerciseLogRow[] = [
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: null, logged_date: iso(1) },
    ];
    expect(computeEffortZoneFromLogs(logs)).toEqual({ hits: 0, total: 0 });
  });
  it('handles empty input', () => {
    expect(computeEffortZoneFromLogs([])).toEqual({ hits: 0, total: 0 });
  });
});

describe('computeStrengthTrendFromLogs', () => {
  it('recent > prior → positive delta (sum across exercises)', () => {
    const logs: ExerciseLogRow[] = [
      // Squat: prior 100, recent 110 → +10
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(20) },
      { exercise_name: 'Squat', weight_kg: 110, reps_in_reserve: 2, logged_date: iso(3) },
      // Bench: prior 80, recent 85 → +5
      { exercise_name: 'Bench', weight_kg: 80, reps_in_reserve: 2, logged_date: iso(25) },
      { exercise_name: 'Bench', weight_kg: 85, reps_in_reserve: 2, logged_date: iso(1) },
    ];
    const r = computeStrengthTrendFromLogs(logs, { today: TODAY });
    expect(r.deltaKg).toBe(15);
    expect(r.exercisesCompared).toBe(2);
  });

  it('flat → 0 (still a real comparison, formats as "+0 kg")', () => {
    const logs: ExerciseLogRow[] = [
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(20) },
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(3) },
    ];
    const r = computeStrengthTrendFromLogs(logs, { today: TODAY });
    expect(r.deltaKg).toBe(0);
    expect(r.exercisesCompared).toBe(1);
    expect(formatStrengthTrend(r)).toBe('+0 kg');
  });

  it('no overlap (only recent OR only prior) → deltaKg null, formats as "—"', () => {
    const recentOnly: ExerciseLogRow[] = [
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(3) },
    ];
    const r1 = computeStrengthTrendFromLogs(recentOnly, { today: TODAY });
    expect(r1.deltaKg).toBeNull();
    expect(formatStrengthTrend(r1)).toBe('—');

    const priorOnly: ExerciseLogRow[] = [
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(25) },
    ];
    const r2 = computeStrengthTrendFromLogs(priorOnly, { today: TODAY });
    expect(r2.deltaKg).toBeNull();
  });

  it('bodyweight rows excluded from trend', () => {
    const logs: ExerciseLogRow[] = [
      // Only bodyweight entries — should contribute nothing.
      { exercise_name: 'Pull-Up', weight_kg: 'bw', reps_in_reserve: 2, logged_date: iso(20) },
      { exercise_name: 'Pull-Up', weight_kg: 'bw', reps_in_reserve: 2, logged_date: iso(2) },
      // Squat has both windows with real weights → +5
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(20) },
      { exercise_name: 'Squat', weight_kg: 105, reps_in_reserve: 2, logged_date: iso(2) },
    ];
    const r = computeStrengthTrendFromLogs(logs, { today: TODAY });
    expect(r.exercisesCompared).toBe(1);
    expect(r.deltaKg).toBe(5);
  });

  it('empty logs → null delta', () => {
    expect(computeStrengthTrendFromLogs([], { today: TODAY }).deltaKg).toBeNull();
  });

  it('exposes the single biggest mover (greatest signed delta) + per-lift deltas', () => {
    const logs: ExerciseLogRow[] = [
      // Squat: prior 100, recent 110 → +10  (the top mover)
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(20) },
      { exercise_name: 'Squat', weight_kg: 110, reps_in_reserve: 2, logged_date: iso(3) },
      // Bench: prior 80, recent 85 → +5
      { exercise_name: 'Bench', weight_kg: 80, reps_in_reserve: 2, logged_date: iso(25) },
      { exercise_name: 'Bench', weight_kg: 85, reps_in_reserve: 2, logged_date: iso(1) },
      // Row: prior 70, recent 65 → -5 (declining)
      { exercise_name: 'Row', weight_kg: 70, reps_in_reserve: 2, logged_date: iso(22) },
      { exercise_name: 'Row', weight_kg: 65, reps_in_reserve: 2, logged_date: iso(2) },
    ];
    const r = computeStrengthTrendFromLogs(logs, { today: TODAY });
    expect(r.topMover).toEqual({ name: 'Squat', deltaKg: 10 });
    expect(r.perLift).toEqual(
      expect.arrayContaining([
        { name: 'Squat', deltaKg: 10 },
        { name: 'Bench', deltaKg: 5 },
        { name: 'Row', deltaKg: -5 },
      ]),
    );
    expect(r.perLift).toHaveLength(3);
  });

  it('top mover can be negative in a down stretch (renderer decides presentation)', () => {
    const logs: ExerciseLogRow[] = [
      { exercise_name: 'Squat', weight_kg: 110, reps_in_reserve: 2, logged_date: iso(20) },
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(3) }, // -10
    ];
    const r = computeStrengthTrendFromLogs(logs, { today: TODAY });
    expect(r.topMover).toEqual({ name: 'Squat', deltaKg: -10 });
  });

  it('no overlap → topMover null, perLift empty', () => {
    const r = computeStrengthTrendFromLogs(
      [{ exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(3) }],
      { today: TODAY },
    );
    expect(r.topMover).toBeNull();
    expect(r.perLift).toEqual([]);
  });

  it('uses per-exercise MAX within each window', () => {
    const logs: ExerciseLogRow[] = [
      // Prior window: max 100
      { exercise_name: 'Squat', weight_kg: 90, reps_in_reserve: 2, logged_date: iso(25) },
      { exercise_name: 'Squat', weight_kg: 100, reps_in_reserve: 2, logged_date: iso(20) },
      // Recent: max 120
      { exercise_name: 'Squat', weight_kg: 110, reps_in_reserve: 2, logged_date: iso(5) },
      { exercise_name: 'Squat', weight_kg: 120, reps_in_reserve: 2, logged_date: iso(1) },
    ];
    expect(computeStrengthTrendFromLogs(logs, { today: TODAY }).deltaKg).toBe(20);
  });
});

describe('formatStrengthTrend', () => {
  it('positive → +N kg', () => {
    expect(formatStrengthTrend({ deltaKg: 7, exercisesCompared: 2 })).toBe('+7 kg');
  });
  it('negative passes through with sign', () => {
    expect(formatStrengthTrend({ deltaKg: -3, exercisesCompared: 1 })).toBe('-3 kg');
  });
  it('null → "—"', () => {
    expect(formatStrengthTrend({ deltaKg: null, exercisesCompared: 0 })).toBe('—');
  });
});
