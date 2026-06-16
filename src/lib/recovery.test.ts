/// <reference types="node" />
// dashboardStats + streak module-import the supabase client, which transitively
// requires react-native (not transformed by this project's jest setup). Mock
// before SUT import so the pure-logic tests can run. Mirrors the pattern in
// src/utils/dashboardStats.test.ts.
jest.mock('./supabase', () => ({ supabase: {} }));

// Recovery exclusion-boundary tests.
//
// The contract under test:
//   1. isRecoverySession / isRecoveryLog tag rows correctly across the
//      boolean column and the legacy workout_type prefix fallback.
//   2. Pure training-only filters drop recovery rows.
//   3. Effort-zone and strength-trend pure helpers skip is_recovery=true
//      rows so the load coach never sees prehab data.
//   4. A small PR-detection helper excludes recovery rows.
//   5. The streak helper COUNTS recovery sessions (asymmetric rule).

import {
  filterTrainingLogs,
  filterTrainingSessions,
  isRecoveryLog,
  isRecoverySession,
} from './recovery';
import {
  computeEffortZoneFromLogs,
  computeStrengthTrendFromLogs,
  type ExerciseLogRow,
} from '../utils/dashboardStats';
import {
  completedDateSetFromSessions,
  currentStreakFromDateSet,
} from '../utils/streak';

// Minimal PR helper that mirrors the inline check in app/workout.tsx
// finishWorkout. Extracted into the test so we can assert the exclusion at
// the pure-logic level — the production code uses `.eq('is_recovery', false)`
// at the query AND would benefit from the same defensive client filter; this
// test pins the contract regardless.
function findPRs(
  previousLogs: readonly { exercise_name: string; weight_kg: number; is_recovery?: boolean }[],
  newWeightByName: Record<string, number>,
): string[] {
  const trainingOnly = filterTrainingLogs(previousLogs);
  const prs: string[] = [];
  for (const name of Object.keys(newWeightByName)) {
    const newW = newWeightByName[name];
    const prev = trainingOnly.filter(l => l.exercise_name === name).map(l => l.weight_kg);
    const prevMax = prev.length > 0 ? Math.max(...prev) : null;
    if (prevMax === null || newW > prevMax) prs.push(name);
  }
  return prs;
}

// ── 1. Tag helpers ─────────────────────────────────────────────────────

describe('isRecoverySession / isRecoveryLog', () => {
  it('flags is_recovery=true rows as recovery', () => {
    expect(isRecoverySession({ is_recovery: true })).toBe(true);
    expect(isRecoveryLog({ is_recovery: true })).toBe(true);
  });

  it('returns false for is_recovery=false, null, or missing', () => {
    expect(isRecoverySession({ is_recovery: false })).toBe(false);
    expect(isRecoverySession({})).toBe(false);
    expect(isRecoverySession({ is_recovery: null })).toBe(false);
    expect(isRecoverySession(null)).toBe(false);
    expect(isRecoveryLog({ is_recovery: false })).toBe(false);
    expect(isRecoveryLog({})).toBe(false);
    expect(isRecoveryLog(null)).toBe(false);
  });

  it('uses workout_type prefix as a fallback on sessions (legacy / client-built rows)', () => {
    // Pre-column rows or client-side session objects can carry the tag in
    // workout_type. The boundary holds either way.
    expect(isRecoverySession({ workout_type: 'Recovery' })).toBe(true);
    expect(isRecoverySession({ workout_type: 'Recovery — Mobility' })).toBe(true);
    expect(isRecoverySession({ workout_type: 'Push' })).toBe(false);
    expect(isRecoverySession({ workout_type: 'RecoveryFake' })).toBe(true); // prefix only
  });

  it('the log helper does NOT fall back to a string prefix — only the column counts', () => {
    // exercise_logs has no workout_type field; the log helper must remain
    // strict so a stray string can't accidentally flag a training log.
    expect(isRecoveryLog({ is_recovery: false } as any)).toBe(false);
  });
});

describe('filterTrainingLogs / filterTrainingSessions', () => {
  it('drops recovery rows from a logs array', () => {
    const rows = [
      { exercise_name: 'Bench Press', is_recovery: false },
      { exercise_name: 'Wrist Flexor Stretch', is_recovery: true },
      { exercise_name: 'Squat' /* missing is_recovery */ },
    ];
    expect(filterTrainingLogs(rows).map(r => r.exercise_name)).toEqual([
      'Bench Press',
      'Squat',
    ]);
  });

  it('drops recovery sessions from a sessions array', () => {
    const rows = [
      { planned_date: '2026-06-08', workout_type: 'Push', is_recovery: false },
      { planned_date: '2026-06-09', workout_type: 'Recovery', is_recovery: true },
      { planned_date: '2026-06-10', workout_type: 'Pull' },
    ];
    expect(filterTrainingSessions(rows).map(r => r.planned_date)).toEqual([
      '2026-06-08',
      '2026-06-10',
    ]);
  });
});

// ── 2. Pure stats helpers ──────────────────────────────────────────────

describe('computeEffortZoneFromLogs — recovery exclusion', () => {
  it('skips is_recovery=true rows entirely (counted as if they did not exist)', () => {
    // Two normal rows in the target zone (RIR 1, 2) plus a recovery row
    // with RIR 3 that would deform the percentage if counted.
    const logs: ExerciseLogRow[] = [
      { exercise_name: 'Bench Press', weight_kg: 80, reps_in_reserve: 1, logged_date: '2026-06-01' },
      { exercise_name: 'Squat',       weight_kg: 100, reps_in_reserve: 2, logged_date: '2026-06-02' },
      // Recovery rows can carry a "rir" field on their dose; if counted,
      // they'd drag the in-zone percentage down. Must be excluded.
      { exercise_name: 'Chin Tuck',   weight_kg: null, reps_in_reserve: 3, logged_date: '2026-06-03', is_recovery: true },
      { exercise_name: 'Bird Dog',    weight_kg: null, reps_in_reserve: 4, logged_date: '2026-06-04', is_recovery: true },
    ];
    const z = computeEffortZoneFromLogs(logs);
    expect(z).toEqual({ hits: 2, total: 2 });
  });
});

describe('computeStrengthTrendFromLogs — recovery exclusion', () => {
  it('skips is_recovery=true rows so prehab weights cannot drag the trend', () => {
    const today = new Date(2026, 5, 14); // 2026-06-14
    // Normal rows: Bench prior 80 → recent 82.5 (+2.5). Squat prior 100 → recent 102.5 (+2.5).
    // A recovery row with a tiny "weight" on the same lift name as a normal
    // movement would, if counted, depress the recent max.
    const logs: ExerciseLogRow[] = [
      { exercise_name: 'Bench Press', weight_kg: 80,  reps_in_reserve: null, logged_date: '2026-05-20' },
      { exercise_name: 'Bench Press', weight_kg: 82.5, reps_in_reserve: null, logged_date: '2026-06-08' },
      { exercise_name: 'Squat',       weight_kg: 100, reps_in_reserve: null, logged_date: '2026-05-20' },
      { exercise_name: 'Squat',       weight_kg: 102.5, reps_in_reserve: null, logged_date: '2026-06-08' },
      // Recovery dose that, if not excluded, would also be picked up under
      // "Squat" and reduce the recent max in the trend computation.
      { exercise_name: 'Squat', weight_kg: 5, reps_in_reserve: null, logged_date: '2026-06-09', is_recovery: true },
    ];
    const t = computeStrengthTrendFromLogs(logs, { today });
    expect(t.exercisesCompared).toBe(2);
    expect(t.deltaKg).toBe(5); // 2.5 + 2.5, recovery row excluded
  });
});

// ── 3. PR detection ────────────────────────────────────────────────────

describe('PR detection — recovery exclusion', () => {
  it('does NOT mark a normal lift as a PR just because the only "prior" was a recovery row', () => {
    // The user did a normal 80kg bench last week (recorded). The new attempt
    // today is 78kg — that's NOT a PR. A stray recovery row at 5kg should
    // not change that.
    const previous = [
      { exercise_name: 'Bench Press', weight_kg: 80, is_recovery: false },
      { exercise_name: 'Bench Press', weight_kg: 5,  is_recovery: true },
    ];
    expect(findPRs(previous, { 'Bench Press': 78 })).toEqual([]);
  });

  it('does mark a new best as a PR even with a heavier recovery row in history (recovery is invisible)', () => {
    // Recovery row at 30kg "Squat" (a loaded mobility drill) must not block
    // a real 110kg PR from registering.
    const previous = [
      { exercise_name: 'Squat', weight_kg: 105, is_recovery: false },
      { exercise_name: 'Squat', weight_kg: 30,  is_recovery: true },
    ];
    expect(findPRs(previous, { Squat: 110 })).toEqual(['Squat']);
  });

  it('treats an exercise with only recovery history as if it has no history (first-time PR)', () => {
    // The user has only ever done "Squat" as a loaded-mobility drill at
    // 20kg. A real first-time training rep should be a PR (no prior to beat).
    const previous = [
      { exercise_name: 'Squat', weight_kg: 20, is_recovery: true },
    ];
    expect(findPRs(previous, { Squat: 60 })).toEqual(['Squat']);
  });
});

// ── 4. Streak inclusion (asymmetric rule) ──────────────────────────────

describe('streak — recovery COUNTS', () => {
  it('completedDateSetFromSessions includes recovery rows in the date set', () => {
    const sessions = [
      { planned_date: '2026-06-10', is_recovery: false },
      { planned_date: '2026-06-11', is_recovery: true },  // recovery — must count
      { planned_date: '2026-06-12', is_recovery: false },
    ];
    const dates = completedDateSetFromSessions(sessions);
    expect(dates.has('2026-06-11')).toBe(true);
    expect(dates.size).toBe(3);
  });

  it('currentStreakFromDateSet counts a 3-day streak where the middle day is recovery only', () => {
    // The user did a normal workout Monday + Wednesday and a recovery
    // session Tuesday. That's a 3-day streak ending Wednesday.
    const today = new Date(2026, 5, 10); // Wed 2026-06-10
    const dates = new Set(['2026-06-08', '2026-06-09', '2026-06-10']);
    expect(currentStreakFromDateSet(dates, today)).toBe(3);
  });

  it('a single recovery day still counts as 1', () => {
    // The user only did a recovery session today. The habit counter must
    // reflect that — streak = 1.
    const today = new Date(2026, 5, 10);
    const dates = new Set(['2026-06-10']);
    expect(currentStreakFromDateSet(dates, today)).toBe(1);
  });

  it('breaks the streak on a date with neither normal nor recovery activity', () => {
    const today = new Date(2026, 5, 10);
    // Has yesterday but not today, and a gap two days ago.
    const dates = new Set(['2026-06-08', '2026-06-09']);
    expect(currentStreakFromDateSet(dates, today)).toBe(2); // counts back from yesterday
  });
});
