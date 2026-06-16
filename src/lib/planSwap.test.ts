// Tests for the exercise-swap persistence transform (src/lib/planSwap.ts)
// and its interaction with the self-heal (src/utils/planCatchUp.ts).
//
// Guarantees under test:
//   - A swap writes into ALL future same-workoutType rows (today + future).
//   - It carries the original sets, takes the rest from the catalog.
//   - No duplicate exercises are ever created.
//   - A swapped row is NOT reverted by ensureCurrentWeekPlan's heal (the heal
//     compares date/workoutType only — exercise differences don't trigger it).
//   - The next block's regenerated rows do not carry the swap (expiry at the
//     block boundary).

import {
  applySwapToRows,
  buildSwapExercise,
  extractPlanDays,
  type PlanRowLike,
  type SwapCatalogEntry,
} from './planSwap';
import { deriveCanonicalWeek, healCurrentWeekRow, weekRowMatchesCanonical } from '../utils/planCatchUp';
import { generatePlan } from './planGeneration';

// Catalog entry the user swaps IN. Reps/rest/equipment/image/muscle come
// from here; sets are carried from the slot being replaced.
const HACK_SQUAT: SwapCatalogEntry = {
  name: 'Hack Squat',
  reps: '8-12',
  restSeconds: 120,
  equipment: 'machine',
  imageUrl: 'https://example.test/hack-squat.jpg',
  primaryMuscle: 'quads',
};

// Three Legs weeks (Mon-anchored) of the current block, each with a
// Leg Extension slot. todayIso is the Monday of the first row.
const TODAY = '2026-06-08';
function legsDay(date: string, legExtSets: number) {
  return {
    day: 'Monday',
    date,
    location: 'gym',
    workoutType: 'Legs',
    muscleGroups: ['Quads', 'Hamstrings'],
    exercises: [
      { name: 'Barbell Squat', sets: 4, reps: '6-10', restSeconds: 120, primaryMuscle: 'quads', equipment: 'barbell' },
      { name: 'Leg Extension', sets: legExtSets, reps: '12-15', restSeconds: 60, primaryMuscle: 'quads', equipment: 'machine' },
    ],
  };
}
function pushDay(date: string) {
  return {
    day: 'Wednesday',
    date,
    location: 'gym',
    workoutType: 'Push',
    muscleGroups: ['Chest'],
    exercises: [{ name: 'Bench Press', sets: 4, reps: '8-12', restSeconds: 90, primaryMuscle: 'chest', equipment: 'barbell' }],
  };
}

function freshRows(): PlanRowLike[] {
  return [
    { weekStart: '2026-06-08', days: [legsDay('2026-06-08', 3), pushDay('2026-06-10')] },
    { weekStart: '2026-06-15', days: [legsDay('2026-06-15', 3), pushDay('2026-06-17')] },
    // Deload week — Leg Extension carries fewer sets; the swap must preserve
    // THAT day's sets, not a fixed value.
    { weekStart: '2026-06-22', days: [legsDay('2026-06-22', 2), pushDay('2026-06-24')] },
  ];
}

describe('buildSwapExercise', () => {
  it('carries the original sets, takes everything else from the catalog', () => {
    expect(buildSwapExercise(HACK_SQUAT, 3)).toEqual({
      name: 'Hack Squat',
      sets: 3,
      reps: '8-12',
      restSeconds: 120,
      primaryMuscle: 'quads',
      equipment: 'machine',
      imageUrl: 'https://example.test/hack-squat.jpg',
    });
  });
});

describe('applySwapToRows — writes into all future same-type rows', () => {
  it('replaces Leg Extension with Hack Squat in every Legs day from today forward', () => {
    const { changedRows } = applySwapToRows({
      rows: freshRows(),
      todayIso: TODAY,
      workoutType: 'Legs',
      swapOutName: 'Leg Extension',
      replacementEntry: HACK_SQUAT,
    });
    // All three Legs weeks changed; no Push rows touched.
    expect(changedRows.map(r => r.weekStart)).toEqual(['2026-06-08', '2026-06-15', '2026-06-22']);
    for (const row of changedRows) {
      const legs = row.days.find(d => d.workoutType === 'Legs')!;
      const names = legs.exercises!.map(e => e.name);
      expect(names).toContain('Hack Squat');
      expect(names).not.toContain('Leg Extension');
      // Push day untouched.
      const push = row.days.find(d => d.workoutType === 'Push')!;
      expect(push.exercises!.map(e => e.name)).toEqual(['Bench Press']);
    }
  });

  it('carries the per-day original sets (deload day keeps its reduced sets)', () => {
    const { changedRows } = applySwapToRows({
      rows: freshRows(),
      todayIso: TODAY,
      workoutType: 'Legs',
      swapOutName: 'Leg Extension',
      replacementEntry: HACK_SQUAT,
    });
    const setsByWeek = Object.fromEntries(
      changedRows.map(r => [
        r.weekStart,
        r.days.find(d => d.workoutType === 'Legs')!.exercises!.find(e => e.name === 'Hack Squat')!.sets,
      ]),
    );
    expect(setsByWeek['2026-06-08']).toBe(3);
    expect(setsByWeek['2026-06-15']).toBe(3);
    expect(setsByWeek['2026-06-22']).toBe(2); // deload sets preserved
  });

  it('skips days strictly before today (from-today-forward only)', () => {
    const rows: PlanRowLike[] = [
      { weekStart: '2026-06-08', days: [legsDay('2026-06-08', 3) /* past */, legsDay('2026-06-12', 3) /* future */] },
    ];
    const { changedRows } = applySwapToRows({
      rows,
      todayIso: '2026-06-10',
      workoutType: 'Legs',
      swapOutName: 'Leg Extension',
      replacementEntry: HACK_SQUAT,
    });
    expect(changedRows).toHaveLength(1);
    const days = changedRows[0].days;
    // Past day (Jun 8) untouched; future day (Jun 12) swapped.
    expect(days[0].exercises!.map(e => e.name)).toContain('Leg Extension');
    expect(days[1].exercises!.map(e => e.name)).toContain('Hack Squat');
  });

  it('NO DUPLICATES: a day already containing the replacement is left unchanged', () => {
    const rows: PlanRowLike[] = [
      {
        weekStart: '2026-06-08',
        days: [
          {
            day: 'Monday',
            date: '2026-06-08',
            workoutType: 'Legs',
            location: 'gym',
            muscleGroups: ['Quads'],
            exercises: [
              { name: 'Hack Squat', sets: 4, reps: '8-12', restSeconds: 120, primaryMuscle: 'quads', equipment: 'machine' },
              { name: 'Leg Extension', sets: 3, reps: '12-15', restSeconds: 60, primaryMuscle: 'quads', equipment: 'machine' },
            ],
          },
        ],
      },
    ];
    const { changedRows } = applySwapToRows({
      rows,
      todayIso: TODAY,
      workoutType: 'Legs',
      swapOutName: 'Leg Extension',
      replacementEntry: HACK_SQUAT,
    });
    // Would create a second Hack Squat → row left unchanged.
    expect(changedRows).toHaveLength(0);
  });

  it('IDEMPOTENT: re-applying after the swap is a no-op', () => {
    const once = applySwapToRows({
      rows: freshRows(),
      todayIso: TODAY,
      workoutType: 'Legs',
      swapOutName: 'Leg Extension',
      replacementEntry: HACK_SQUAT,
    });
    const twice = applySwapToRows({
      rows: once.changedRows, // feed the already-swapped rows back in
      todayIso: TODAY,
      workoutType: 'Legs',
      swapOutName: 'Leg Extension',
      replacementEntry: HACK_SQUAT,
    });
    expect(twice.changedRows).toHaveLength(0);
  });

  it('matches names case-insensitively', () => {
    const { changedRows } = applySwapToRows({
      rows: freshRows(),
      todayIso: TODAY,
      workoutType: 'Legs',
      swapOutName: 'leg extension',
      replacementEntry: HACK_SQUAT,
    });
    expect(changedRows).toHaveLength(3);
  });

  it('does not touch rows whose only matching day is a different workoutType', () => {
    const rows: PlanRowLike[] = [{ weekStart: '2026-06-08', days: [pushDay('2026-06-10')] }];
    const { changedRows } = applySwapToRows({
      rows,
      todayIso: TODAY,
      workoutType: 'Legs',
      swapOutName: 'Leg Extension',
      replacementEntry: HACK_SQUAT,
    });
    expect(changedRows).toHaveLength(0);
  });
});

describe('extractPlanDays', () => {
  it('unwraps an array column', () => {
    expect(extractPlanDays([{ workoutType: 'Legs' }])).toEqual([{ workoutType: 'Legs' }]);
  });
  it('unwraps a legacy { days: [...] } column', () => {
    expect(extractPlanDays({ days: [{ workoutType: 'Legs' }] })).toEqual([{ workoutType: 'Legs' }]);
  });
  it('returns [] for null / malformed', () => {
    expect(extractPlanDays(null)).toEqual([]);
    expect(extractPlanDays(undefined)).toEqual([]);
    expect(extractPlanDays({})).toEqual([]);
  });
});

describe('swap survives the self-heal', () => {
  // Build a canonical PPL week, then swap an exercise inside it. The heal
  // compares (date, workoutType) only, so the swapped week must still read
  // as canonical and NOT be reverted.
  const healArgs = {
    weekStartIso: '2026-06-08',
    completedBeforeWeek: 2, // position 2 → Legs leads this week
    trainingDays: 3,
    fitnessLevel: 'beginner' as const,
    location: 'gym' as const,
    blockIndex: 0,
    blockWeek: 1,
  };

  it('a swapped day still matches canonical (date/workoutType unchanged)', () => {
    const canonical = deriveCanonicalWeek(healArgs);
    const legs = canonical.find(d => d.workoutType === 'Legs');
    expect(legs).toBeDefined();
    // Swap the first exercise of the Legs day for Hack Squat.
    const swapOut = legs!.exercises[0].name;
    const { changedRows } = applySwapToRows({
      rows: [{ weekStart: '2026-06-08', days: canonical as any }],
      todayIso: '2026-06-08',
      workoutType: 'Legs',
      swapOutName: swapOut,
      replacementEntry: HACK_SQUAT,
    });
    expect(changedRows).toHaveLength(1);
    const swappedDays = changedRows[0].days as any;
    // The heal's structural comparison still sees a canonical week.
    expect(weekRowMatchesCanonical(swappedDays, canonical)).toBe(true);
  });

  it('healCurrentWeekRow does NOT revert the swapped exercises', () => {
    const canonical = deriveCanonicalWeek(healArgs);
    const legs = canonical.find(d => d.workoutType === 'Legs')!;
    const swapOut = legs.exercises[0].name;
    const { changedRows } = applySwapToRows({
      rows: [{ weekStart: '2026-06-08', days: canonical as any }],
      todayIso: '2026-06-08',
      workoutType: 'Legs',
      swapOutName: swapOut,
      replacementEntry: HACK_SQUAT,
    });
    const swappedDays = changedRows[0].days as any;

    const result = healCurrentWeekRow(swappedDays, healArgs);
    expect(result.healed).toBe(false); // no rewrite triggered
    // The returned days are the swapped ones — Hack Squat preserved.
    const healedLegs = result.days.find(d => d.workoutType === 'Legs')!;
    expect(healedLegs.exercises.map(e => e.name)).toContain('Hack Squat');
    expect(healedLegs.exercises.map(e => e.name)).not.toContain(swapOut);
  });
});

describe('swap expires at the block boundary', () => {
  // A deliberately synthetic name that does NOT exist in the catalog, so
  // generatePlan can never independently produce it — its presence anywhere
  // is therefore proof the swap leaked.
  const SYNTH: SwapCatalogEntry = {
    name: 'Custom Pendulum Squat 9000',
    reps: '8-12',
    restSeconds: 120,
    equipment: 'machine',
    imageUrl: 'https://example.test/synth.jpg',
    primaryMuscle: 'quads',
  };

  it("the next block's freshly generated rows do not carry the swap", () => {
    // Current block (block 0) Legs rows get the swap.
    const block0 = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 3,
      location: 'gym',
      weeksAhead: 1,
      startDate: '2026-06-08',
      dayIndexOffset: 2, // Legs leads
      blockIndex: 0,
      blockWeek: 1,
    });
    const legs0 = block0.find(d => d.workoutType === 'Legs')!;
    const swapOut = legs0.exercises[0].name;
    const { changedRows } = applySwapToRows({
      rows: [{ weekStart: '2026-06-08', days: block0 as any }],
      todayIso: '2026-06-08',
      workoutType: 'Legs',
      swapOutName: swapOut,
      replacementEntry: SYNTH,
    });
    expect(changedRows[0].days.find(d => d.workoutType === 'Legs')!.exercises!.map(e => e.name)).toContain(SYNTH.name);

    // The next block (block 1) is generated LATER, fresh from the catalog —
    // it is never passed through applySwapToRows, so it cannot contain the
    // swap. Regenerate the equivalent Legs week at block 1 and confirm.
    const block1 = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 3,
      location: 'gym',
      weeksAhead: 1,
      startDate: '2026-07-06', // 4 weeks later
      dayIndexOffset: 2,
      blockIndex: 1,
      blockWeek: 1,
    });
    const legs1 = block1.find(d => d.workoutType === 'Legs')!;
    expect(legs1.exercises.map(e => e.name)).not.toContain(SYNTH.name);
  });
});
