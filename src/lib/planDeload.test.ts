// Unit tests for the tap-to-accept deload transforms (early / skip) and the
// guarantees they must hold: correct sets, idempotency, from-today-forward
// scope (block-boundary expiry), and — critically — that an accepted change
// is NOT reverted by ensureCurrentWeekPlan's (date, workoutType)-only heal.

import {
  applyDeloadToRows,
  clearDeloadFromRows,
  undeloadSets,
  undeloadReps,
  extractPlanDays,
  type PlanRowLike,
} from './planDeload';
import { deloadSets, deloadReps } from './planGeneration';
import { weekRowMatchesCanonical } from '../utils/planCatchUp';

const TODAY = '2026-06-15';

// A normal (non-deload) active-week row: two training days from today forward.
function normalRow(): PlanRowLike {
  return {
    weekStart: TODAY,
    days: [
      {
        day: 'Monday',
        date: '2026-06-15',
        workoutType: 'Push',
        exercises: [
          { name: 'Bench Press', sets: 4, reps: '8-12', restSeconds: 120, primaryMuscle: 'chest' },
          { name: 'Lateral Raise', sets: 3, reps: '12-15', restSeconds: 60, primaryMuscle: 'shoulders' },
        ],
      },
      {
        day: 'Thursday',
        date: '2026-06-18',
        workoutType: 'Legs',
        exercises: [
          { name: 'Squat', sets: 5, reps: '6-8', restSeconds: 180, primaryMuscle: 'quads' },
        ],
      },
    ],
  };
}

describe('applyDeloadToRows (pull forward)', () => {
  it('reduces sets via deloadSets, bumps reps via deloadReps, stamps deload:true', () => {
    const { changedRows } = applyDeloadToRows({ rows: [normalRow()], todayIso: TODAY });
    expect(changedRows).toHaveLength(1);
    const days = changedRows[0].days;
    // Push day
    expect(days[0].deload).toBe(true);
    expect(days[0].exercises![0].sets).toBe(deloadSets(4)); // 3
    expect(days[0].exercises![0].reps).toBe(deloadReps('8-12')); // "10-14"
    expect(days[0].exercises![1].sets).toBe(deloadSets(3)); // 2
    // Legs day
    expect(days[1].deload).toBe(true);
    expect(days[1].exercises![0].sets).toBe(deloadSets(5)); // 3
    expect(days[1].exercises![0].reps).toBe(deloadReps('6-8')); // "8-10"
  });

  it('preserves exercise identity + workoutType + date (only volume changes)', () => {
    const { changedRows } = applyDeloadToRows({ rows: [normalRow()], todayIso: TODAY });
    const orig = normalRow();
    changedRows[0].days.forEach((d, i) => {
      expect(d.workoutType).toBe(orig.days[i].workoutType);
      expect(d.date).toBe(orig.days[i].date);
      expect(d.exercises!.map(e => e.name)).toEqual(orig.days[i].exercises!.map(e => e.name));
    });
  });

  it('leaves days dated before today untouched (from-today-forward scope)', () => {
    const row: PlanRowLike = {
      weekStart: '2026-06-12',
      days: [
        { day: 'Friday', date: '2026-06-13', workoutType: 'Pull', exercises: [{ name: 'Row', sets: 4, reps: '8-10' }] }, // past
        { day: 'Monday', date: '2026-06-15', workoutType: 'Push', exercises: [{ name: 'Bench', sets: 4, reps: '8-12' }] }, // today
      ],
    };
    const { changedRows } = applyDeloadToRows({ rows: [row], todayIso: TODAY });
    const days = changedRows[0].days;
    expect(days[0].deload).toBeUndefined(); // past — untouched
    expect(days[0].exercises![0].sets).toBe(4);
    expect(days[1].deload).toBe(true); // today — deloaded
  });

  it('idempotent: a day already marked deload is not re-changed', () => {
    const once = applyDeloadToRows({ rows: [normalRow()], todayIso: TODAY }).changedRows[0];
    const twice = applyDeloadToRows({ rows: [once], todayIso: TODAY });
    expect(twice.changedRows).toHaveLength(0);
  });
});

describe('clearDeloadFromRows (skip)', () => {
  // A scheduled week-4 deload row: same exercises, reduced sets, deload:true.
  function deloadRow(): PlanRowLike {
    return {
      weekStart: TODAY,
      days: [
        {
          day: 'Monday',
          date: '2026-06-15',
          workoutType: 'Push',
          deload: true,
          exercises: [{ name: 'Bench Press', sets: 3, reps: '10-14', restSeconds: 120, primaryMuscle: 'chest' }],
        },
      ],
    };
  }

  it('restores sets (upward) + reps and clears the deload flag', () => {
    const { changedRows } = clearDeloadFromRows({ rows: [deloadRow()], todayIso: TODAY });
    expect(changedRows).toHaveLength(1);
    const d = changedRows[0].days[0];
    expect(d.deload).toBe(false);
    expect(d.exercises![0].sets).toBe(undeloadSets(3)); // 5 — restored upward
    expect(d.exercises![0].reps).toBe(undeloadReps('10-14')); // "8-12"
  });

  it('idempotent: a non-deload day is not changed', () => {
    const { changedRows } = clearDeloadFromRows({ rows: [normalRow()], todayIso: TODAY });
    expect(changedRows).toHaveLength(0);
  });
});

describe('undeload helpers', () => {
  it('undeloadReps exactly inverts deloadReps (+2 → −2)', () => {
    expect(undeloadReps(deloadReps('6-8'))).toBe('6-8');
    expect(undeloadReps(deloadReps('10'))).toBe('10');
    expect(undeloadReps(deloadReps(8))).toBe(8);
  });
  it('undeloadSets restores volume upward, floored at 1', () => {
    expect(undeloadSets(2)).toBe(3);
    expect(undeloadSets(3)).toBe(5);
    expect(undeloadSets(0)).toBe(1);
  });
  it('round-trip is non-reducing (a skipped deload never leaves you lighter)', () => {
    for (const s of [3, 4, 5]) {
      expect(undeloadSets(deloadSets(s))).toBeGreaterThanOrEqual(s - 0); // 3→2→3, 4→3→5, 5→3→5
    }
  });
});

describe('self-heal safety — an accepted deload is NOT reverted', () => {
  // ensureCurrentWeekPlan's active-week heal compares (date, workoutType)
  // pairs ONLY (weekRowMatchesCanonical). A deload changes sets/reps/flag,
  // never date or workoutType, so the deloaded row still reads as canonical
  // against the NORMAL canonical week and is left in place.
  it('deloaded active week still matches the normal canonical week on (date, type)', () => {
    const normal = normalRow();
    const deloaded = applyDeloadToRows({ rows: [normal], todayIso: TODAY }).changedRows[0];
    expect(weekRowMatchesCanonical(deloaded.days, normal.days)).toBe(true);
  });
  it('a skipped (un-deloaded) week likewise matches the deload canonical on (date, type)', () => {
    const scheduled: PlanRowLike = {
      weekStart: TODAY,
      days: [
        { day: 'Monday', date: '2026-06-15', workoutType: 'Push', deload: true, exercises: [{ name: 'Bench', sets: 3, reps: '10-14' }] },
      ],
    };
    const skipped = clearDeloadFromRows({ rows: [scheduled], todayIso: TODAY }).changedRows[0];
    expect(weekRowMatchesCanonical(skipped.days, scheduled.days)).toBe(true);
  });
});

describe('extractPlanDays', () => {
  it('unwraps array and legacy { days } shapes', () => {
    expect(extractPlanDays([{ day: 'Mon' }])).toEqual([{ day: 'Mon' }]);
    expect(extractPlanDays({ days: [{ day: 'Tue' }] })).toEqual([{ day: 'Tue' }]);
    expect(extractPlanDays(null)).toEqual([]);
  });
});
