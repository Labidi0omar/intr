import {
  ANCHOR_BASIS_LABEL,
  basisForExercise,
  buildAnchorWorkingWeights,
  deriveFromAnchors,
} from './anchorDerivation';
import { ANCHOR_LIFTS } from './anchorSeed';
import { EXERCISES } from '../constants/exercises';

// A self-consistent intermediate lifter's anchor working weights — the
// SAME profile used in the PR report's worked examples. Bench 100kg x 5
// is the exact figure from the product spec's example; the other four
// are plausible companions run through the same anchorSeed e1RM pipeline
// (not re-derived here — these are just the resulting working weights).
const ANCHORS = {
  bench: 82.5,     // from 100kg x 5, Barbell Bench Press (8-12 range)
  squat: 107.5,    // from 130kg x 5, Barbell Squat (8-12 range)
  deadlift: 142.5, // from 160kg x 5, Deadlift (5-8 range)
  overhead: 45,    // from 55kg x 5, Overhead Press (8-12 range)
  row: 62.5,        // from 75kg x 5, Barbell Row (8-12 range)
};

describe('deriveFromAnchors — worked examples (report-required set)', () => {
  it('Incline Barbell Bench Press: 82.5 x 0.85 -> 70kg', () => {
    expect(deriveFromAnchors({ exerciseName: 'Incline Barbell Bench Press', anchorWorkingWeights: ANCHORS })).toBe(70);
  });

  it('Decline Barbell Press: 82.5 x 0.95 -> 77.5kg', () => {
    expect(deriveFromAnchors({ exerciseName: 'Decline Barbell Press', anchorWorkingWeights: ANCHORS })).toBe(77.5);
  });

  it('Close Grip Bench Press: 82.5 x 0.85 -> 70kg', () => {
    expect(deriveFromAnchors({ exerciseName: 'Close Grip Bench Press', anchorWorkingWeights: ANCHORS })).toBe(70);
  });

  it('Dumbbell Bench Press: 82.5 x 0.45 -> 37.5kg (per dumbbell)', () => {
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Bench Press', anchorWorkingWeights: ANCHORS })).toBe(37.5);
  });

  it('Cable Fly: 82.5 x 0.20 -> 17.5kg (light isolation, not forced near the anchor)', () => {
    const kg = deriveFromAnchors({ exerciseName: 'Cable Fly', anchorWorkingWeights: ANCHORS })!;
    expect(kg).toBe(17.5);
    expect(kg).toBeLessThan(ANCHORS.bench * 0.3);
  });

  it('Lateral Raise: 45 x 0.18 -> 7.5kg (very light, textbook isolation)', () => {
    const kg = deriveFromAnchors({ exerciseName: 'Lateral Raise', anchorWorkingWeights: ANCHORS })!;
    expect(kg).toBe(7.5);
    expect(kg).toBeLessThan(ANCHORS.overhead * 0.3);
  });

  it('Lat Pulldown: 62.5 x 0.70 -> 45kg', () => {
    expect(deriveFromAnchors({ exerciseName: 'Lat Pulldown', anchorWorkingWeights: ANCHORS })).toBe(45);
  });

  it('Leg Press: 107.5 x 1.50 -> 162.5kg (ratio > 1 is legitimate for this pattern)', () => {
    const kg = deriveFromAnchors({ exerciseName: 'Leg Press', anchorWorkingWeights: ANCHORS })!;
    expect(kg).toBe(162.5);
    // The credibility check runs BOTH directions: leg press must clear
    // the squat anchor by a wide margin (an ~equal number would look
    // broken to anyone who's used a leg press machine), not just avoid
    // being absurdly heavy.
    expect(kg).toBeGreaterThan(ANCHORS.squat);
  });

  it('Leg Curl: 142.5 x 0.30 -> 42.5kg', () => {
    expect(deriveFromAnchors({ exerciseName: 'Leg Curl', anchorWorkingWeights: ANCHORS })).toBe(42.5);
  });
});

// ── Equipment-aware rounding ────────────────────────────────────────────
// A pure 2.5kg-grid round isn't enough: a per-hand dumbbell result has to
// land on a weight that a dumbbell RACK actually stocks (5, 7.5, 10, 12.5,
// …), never an off-grid number like 8kg. This is the exact bug that
// shipped for Incline Dumbbell Press (floorKg: 8, an unrounded constant
// that leaked straight through the old rounded-then-maxed order of
// operations) — these tests pin the fix at the unit level, not just the
// one exercise that happened to surface it.

describe('deriveFromAnchors — equipment-aware rounding', () => {
  it('REGRESSION: Incline Dumbbell Press never returns 8kg (the exact reported bug)', () => {
    const kg = deriveFromAnchors({ exerciseName: 'Incline Dumbbell Press', anchorWorkingWeights: { bench: 20 } });
    expect(kg).not.toBe(8);
    expect(kg).toBe(10); // floored, on-grid
  });

  it('every dumbbell-equipment mapped exercise always lands on the 2.5kg grid with a 5kg minimum, across a sweep of anchor weights', () => {
    const dumbbellNames = EXERCISES
      .filter(e => e.equipment === 'dumbbell')
      .map(e => e.name)
      .filter(name => basisForExercise(name) !== null);
    expect(dumbbellNames.length).toBeGreaterThan(0);

    // Sweep low, mid, and high anchor weights — the off-grid bug only
    // shows up for SOME raw ratio results, not all, so a single anchor
    // value isn't enough to catch a regression.
    const sweepAnchors = [15, 20, 27, 33, 41, 58, 73, 90, 110, 145];
    for (const name of dumbbellNames) {
      for (const anchorKg of sweepAnchors) {
        const basis = basisForExercise(name)!;
        const kg = deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: { [basis]: anchorKg } });
        expect(kg).not.toBeNull();
        expect(kg!).toBeGreaterThanOrEqual(5);
        // Multiple of 2.5 — floating point safe via a rounded modulo check.
        expect(Math.round((kg! % 2.5) * 100) / 100).toBe(0);
      }
    }
  });

  it('every barbell/cable/machine mapped exercise lands on the 2.5kg plate grid (2.5kg minimum), across the same sweep', () => {
    const plateGridNames = EXERCISES
      .filter(e => e.equipment === 'barbell' || e.equipment === 'cable' || e.equipment === 'machine')
      .map(e => e.name)
      .filter(name => basisForExercise(name) !== null);
    expect(plateGridNames.length).toBeGreaterThan(0);

    const sweepAnchors = [15, 20, 27, 33, 41, 58, 73, 90, 110, 145];
    for (const name of plateGridNames) {
      for (const anchorKg of sweepAnchors) {
        const basis = basisForExercise(name)!;
        const kg = deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: { [basis]: anchorKg } });
        expect(kg).not.toBeNull();
        expect(kg!).toBeGreaterThanOrEqual(2.5);
        expect(Math.round((kg! % 2.5) * 100) / 100).toBe(0);
      }
    }
  });

});

// ── Floor mechanism — two anchor profiles side by side ─────────────────
// A pure ratio collapses at low anchor weights (bug report: bench-anchor
// 20kg -> Tricep Pushdown 5kg, absurd). LOW is a true beginner who can
// only move the empty Olympic bar on every lift — every anchor is 20kg.
// HIGH is a realistic solid-intermediate profile. For every exercise
// below, the floor should visibly win at LOW (the ratio alone would be
// too light) and the ratio should visibly win at HIGH (well clear of the
// floor) — pinning both directions is the point of this suite, not just
// "the number changed." Floors here are the RECALIBRATED, muscle-group-
// specific values (see the PR report) — chest floors are no longer
// standing in for every other muscle group's minimum.

const LOW_ANCHORS = { bench: 20, squat: 20, deadlift: 20, overhead: 20, row: 20 };
const HIGH_ANCHORS = { bench: 80, squat: 100, deadlift: 130, overhead: 50, row: 70 };

describe('deriveFromAnchors — floor mechanism (LOW vs HIGH anchor profiles)', () => {
  it('Incline Barbell Bench Press: NO FLOOR — pure ratio at both ends, never floored above the anchor', () => {
    // 20 x 0.85 = 17 -> 17.5. 80 x 0.85 = 68 -> 67.5. A true beginner who
    // can only bench the bar genuinely can't incline more than that either
    // — flooring this would suggest a load heavier than their own anchor.
    expect(deriveFromAnchors({ exerciseName: 'Incline Barbell Bench Press', anchorWorkingWeights: LOW_ANCHORS })).toBe(17.5);
    expect(deriveFromAnchors({ exerciseName: 'Incline Barbell Bench Press', anchorWorkingWeights: HIGH_ANCHORS })).toBe(67.5);
  });

  it('Dumbbell Bench Press: floor (12.5) wins at LOW, ratio wins at HIGH', () => {
    // 20 x 0.45 = 9 -> floored up to 12.5. 80 x 0.45 = 36 -> 35 (rounds
    // down to the nearest real dumbbell), well clear of the floor.
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Bench Press', anchorWorkingWeights: LOW_ANCHORS })).toBe(12.5);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Bench Press', anchorWorkingWeights: HIGH_ANCHORS })).toBe(35);
  });

  it('Cable Fly: floor (10) wins at LOW, ratio wins at HIGH', () => {
    // 20 x 0.20 = 4 -> floored up to 10. 80 x 0.20 = 16 -> 15.
    expect(deriveFromAnchors({ exerciseName: 'Cable Fly', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Cable Fly', anchorWorkingWeights: HIGH_ANCHORS })).toBe(15);
  });

  it('Tricep Pushdown: floor (20) wins at LOW, ratio (0.28) clears it cleanly at HIGH', () => {
    // The bug: 20 x 0.25 = 5kg, "absurd; a beginner does 20-30kg." Fixed:
    // floored up to 20 — squarely in the "beginner does 20-30kg" range
    // the bug report itself cited. Ratio bumped 0.25 -> 0.28 so the
    // HIGH-profile output clears the floor with daylight (80 x 0.28 =
    // 22.4 -> 22.5) instead of the old coincidental tie at exactly 20.
    expect(deriveFromAnchors({ exerciseName: 'Tricep Pushdown', anchorWorkingWeights: LOW_ANCHORS })).toBe(20);
    expect(deriveFromAnchors({ exerciseName: 'Tricep Pushdown', anchorWorkingWeights: HIGH_ANCHORS })).toBe(22.5);
    expect(deriveFromAnchors({ exerciseName: 'Tricep Pushdown', anchorWorkingWeights: { bench: 100 } })).toBe(27.5);
  });

  it('Lateral Raise: floor (5) wins at LOW, ratio wins at HIGH', () => {
    // 20 x 0.18 = 3.6 -> floored up to 5. 50 x 0.18 = 9 -> 10.
    expect(deriveFromAnchors({ exerciseName: 'Lateral Raise', anchorWorkingWeights: LOW_ANCHORS })).toBe(5);
    expect(deriveFromAnchors({ exerciseName: 'Lateral Raise', anchorWorkingWeights: HIGH_ANCHORS })).toBe(10);
  });

  it('Lat Pulldown: floor (30) wins at LOW, ratio wins at HIGH', () => {
    // 20 x 0.70 = 14 -> floored up to 30. 70 x 0.70 = 49 -> 50.
    expect(deriveFromAnchors({ exerciseName: 'Lat Pulldown', anchorWorkingWeights: LOW_ANCHORS })).toBe(30);
    expect(deriveFromAnchors({ exerciseName: 'Lat Pulldown', anchorWorkingWeights: HIGH_ANCHORS })).toBe(50);
  });

  it('Leg Press: floor (60) wins at LOW, ratio wins at HIGH', () => {
    // 20 x 1.50 = 30 -> floored up to 60 (a real leg-press sled alone
    // often weighs 20-45kg unloaded — a bare-ratio number can undershoot
    // the empty machine). 100 x 1.50 = 150 -> 150, well clear.
    expect(deriveFromAnchors({ exerciseName: 'Leg Press', anchorWorkingWeights: LOW_ANCHORS })).toBe(60);
    expect(deriveFromAnchors({ exerciseName: 'Leg Press', anchorWorkingWeights: HIGH_ANCHORS })).toBe(150);
  });

  it('Leg Curl: floor (20) wins at LOW, ratio wins at HIGH', () => {
    // 20 x 0.30 = 6 -> floored up to 20. 130 x 0.30 = 39 -> 40.
    expect(deriveFromAnchors({ exerciseName: 'Leg Curl', anchorWorkingWeights: LOW_ANCHORS })).toBe(20);
    expect(deriveFromAnchors({ exerciseName: 'Leg Curl', anchorWorkingWeights: HIGH_ANCHORS })).toBe(40);
  });

  it('every floored exercise: LOW-profile output is never below its floor, and the HIGH-profile output clears the floor', () => {
    const floored: { name: string; floorKg: number }[] = [
      { name: 'Dumbbell Bench Press', floorKg: 12.5 },
      { name: 'Incline Dumbbell Press', floorKg: 10 },
      { name: 'Decline Dumbbell Press', floorKg: 12.5 },
      { name: 'Cable Fly', floorKg: 10 },
      { name: 'High Cable Fly', floorKg: 10 },
      { name: 'Dumbbell Fly', floorKg: 7.5 },
      { name: 'Dumbbell Pullover', floorKg: 10 },
      { name: 'Tricep Pushdown', floorKg: 20 },
      { name: 'Cable Overhead Tricep Extension', floorKg: 20 },
      { name: 'Overhead Tricep Extension', floorKg: 10 },
      { name: 'Tricep Kickback', floorKg: 5 },
      { name: 'Skull Crushers', floorKg: 12.5 },
      { name: 'EZ Bar Skull Crusher', floorKg: 12.5 },
      { name: 'Dumbbell Shoulder Press', floorKg: 10 },
      { name: 'Seated Dumbbell Press', floorKg: 10 },
      { name: 'Arnold Press', floorKg: 10 },
      { name: 'Machine Shoulder Press', floorKg: 15 },
      { name: 'Lateral Raise', floorKg: 5 },
      { name: 'Front Raise', floorKg: 5 },
      { name: 'Cable Lateral Raise', floorKg: 5 },
      { name: 'T-Bar Row', floorKg: 15 },
      { name: 'Dumbbell Row', floorKg: 12.5 },
      { name: 'Chest Supported Row', floorKg: 12.5 },
      { name: 'Lat Pulldown', floorKg: 30 },
      { name: 'Close Grip Lat Pulldown', floorKg: 30 },
      { name: 'Cable Row', floorKg: 30 },
      { name: 'Wide Grip Cable Row', floorKg: 30 },
      { name: 'Face Pull', floorKg: 10 },
      { name: 'Cable Face Pull High', floorKg: 10 },
      { name: 'Reverse Fly', floorKg: 5 },
      { name: 'Bent Over Rear Delt Fly', floorKg: 5 },
      { name: 'Seated Rear Delt Raise', floorKg: 5 },
      { name: 'Rear Delt Barbell Row', floorKg: 7.5 },
      { name: 'Barbell Curl', floorKg: 15 },
      { name: 'EZ Bar Curl', floorKg: 15 },
      { name: 'Preacher Curl', floorKg: 15 },
      { name: 'Cable Curl', floorKg: 10 },
      { name: 'Dumbbell Curl', floorKg: 7.5 },
      { name: 'Hammer Curl', floorKg: 7.5 },
      { name: 'Incline Dumbbell Curl', floorKg: 7.5 },
      { name: 'Concentration Curl', floorKg: 7.5 },
      { name: 'Zottman Curl', floorKg: 7.5 },
      { name: 'Leg Press', floorKg: 60 },
      { name: 'Hack Squat', floorKg: 40 },
      { name: 'Goblet Squat', floorKg: 10 },
      { name: 'Dumbbell Lunges', floorKg: 10 },
      { name: 'Leg Extension', floorKg: 20 },
      { name: 'Seated Calf Raise', floorKg: 40 },
      { name: 'Standing Calf Raise', floorKg: 40 },
      { name: 'Dumbbell RDL', floorKg: 10 },
      { name: 'Leg Curl', floorKg: 20 },
      { name: 'Back Extension', floorKg: 10 },
    ];

    for (const { name, floorKg } of floored) {
      const lowKg = deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: LOW_ANCHORS });
      const highKg = deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: HIGH_ANCHORS });
      expect(lowKg).not.toBeNull();
      expect(highKg).not.toBeNull();
      expect(lowKg!).toBeGreaterThanOrEqual(floorKg);
      expect(highKg!).toBeGreaterThanOrEqual(floorKg);
    }
  });

  it('barbell-compound-variant family carries NO floor and can legitimately fall below what a floored exercise would need', () => {
    // At the LOW (bar-only) profile, these should be free to output
    // whatever the pure ratio says — including values that would be
    // "too light" for a floored cable/machine exercise, because that's
    // an honest reflection of a true beginner's capability on the SAME
    // loading mechanism as their anchor.
    const noFloorNames = [
      'Incline Barbell Bench Press',
      'Decline Barbell Press',
      'Close Grip Bench Press',
      'Paused Bench Press',
      'Board Press',
      'Seated Barbell Press',
      'Upright Row',
      'Romanian Deadlift',
      'Hip Thrust',
    ];
    for (const name of noFloorNames) {
      const lowKg = deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: LOW_ANCHORS })!;
      const anchor = LOW_ANCHORS[basisForExercise(name)!];
      // Sanity: the LOW output is still a positive, plate-rounded number —
      // proves it went through the plate grid rather than being some
      // untouched raw float — and stays proportional to the anchor (no
      // floor inflating it past what the ratio alone would produce).
      expect(lowKg).toBeGreaterThan(0);
      expect(lowKg % 2.5).toBe(0);
      expect(lowKg).toBeLessThanOrEqual(anchor * 1.3); // no ratio here exceeds ~1.3x its own anchor
    }
  });
});

// ── Every muscle group at BOTH the LOW (beginner) and HIGH (realistic
// intermediate) anchor profiles ─────────────────────────────────────────
// The full calibration-audit suite: every group below must be BOTH a
// weight that physically exists for its equipment AND beginner-sane at
// LOW / intermediate-sane at HIGH. Pins the exact worked-examples table
// from the PR report — no muscle group is chest-reasoning-by-proxy
// anymore.

describe('deriveFromAnchors — every muscle group, LOW (beginner) and HIGH (intermediate) anchors', () => {
  it('Chest: DB Bench, Incline DB, Cable Fly', () => {
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Bench Press', anchorWorkingWeights: LOW_ANCHORS })).toBe(12.5);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Bench Press', anchorWorkingWeights: HIGH_ANCHORS })).toBe(35);
    expect(deriveFromAnchors({ exerciseName: 'Incline Dumbbell Press', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Incline Dumbbell Press', anchorWorkingWeights: HIGH_ANCHORS })).toBe(30);
    expect(deriveFromAnchors({ exerciseName: 'Cable Fly', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Cable Fly', anchorWorkingWeights: HIGH_ANCHORS })).toBe(15);
    // No catalog match for "pec deck" — EXERCISES has no such entry
    // (Cable Fly / High Cable Fly / Dumbbell Fly cover chest-fly work).
    expect(EXERCISES.some(e => e.name.toLowerCase().includes('pec deck'))).toBe(false);
  });

  it('Back: Lat Pulldown, Cable Row, DB Row, Face Pull', () => {
    expect(deriveFromAnchors({ exerciseName: 'Lat Pulldown', anchorWorkingWeights: LOW_ANCHORS })).toBe(30);
    expect(deriveFromAnchors({ exerciseName: 'Lat Pulldown', anchorWorkingWeights: HIGH_ANCHORS })).toBe(50);
    expect(deriveFromAnchors({ exerciseName: 'Cable Row', anchorWorkingWeights: LOW_ANCHORS })).toBe(30);
    expect(deriveFromAnchors({ exerciseName: 'Cable Row', anchorWorkingWeights: HIGH_ANCHORS })).toBe(55);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Row', anchorWorkingWeights: LOW_ANCHORS })).toBe(12.5);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Row', anchorWorkingWeights: HIGH_ANCHORS })).toBe(32.5);
    expect(deriveFromAnchors({ exerciseName: 'Face Pull', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Face Pull', anchorWorkingWeights: HIGH_ANCHORS })).toBe(15);
  });

  it('Shoulders: DB Press, Lateral, Front, Rear-Delt, Upright Row', () => {
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Shoulder Press', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Shoulder Press', anchorWorkingWeights: HIGH_ANCHORS })).toBe(22.5);
    expect(deriveFromAnchors({ exerciseName: 'Lateral Raise', anchorWorkingWeights: LOW_ANCHORS })).toBe(5);
    expect(deriveFromAnchors({ exerciseName: 'Lateral Raise', anchorWorkingWeights: HIGH_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Front Raise', anchorWorkingWeights: LOW_ANCHORS })).toBe(5);
    expect(deriveFromAnchors({ exerciseName: 'Front Raise', anchorWorkingWeights: HIGH_ANCHORS })).toBe(7.5);
    expect(deriveFromAnchors({ exerciseName: 'Bent Over Rear Delt Fly', anchorWorkingWeights: LOW_ANCHORS })).toBe(5);
    expect(deriveFromAnchors({ exerciseName: 'Bent Over Rear Delt Fly', anchorWorkingWeights: HIGH_ANCHORS })).toBe(7.5);
    // Upright Row: barbell, no floor — see the "known edge case" note in
    // anchorDerivation.ts for why the LOW value can sit below an empty
    // bar's own weight.
    expect(deriveFromAnchors({ exerciseName: 'Upright Row', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Upright Row', anchorWorkingWeights: HIGH_ANCHORS })).toBe(22.5);
  });

  it('Quads: Leg Press, Hack Squat, Extension, Lunge', () => {
    expect(deriveFromAnchors({ exerciseName: 'Leg Press', anchorWorkingWeights: LOW_ANCHORS })).toBe(60);
    expect(deriveFromAnchors({ exerciseName: 'Leg Press', anchorWorkingWeights: HIGH_ANCHORS })).toBe(150);
    expect(deriveFromAnchors({ exerciseName: 'Hack Squat', anchorWorkingWeights: LOW_ANCHORS })).toBe(40);
    expect(deriveFromAnchors({ exerciseName: 'Hack Squat', anchorWorkingWeights: HIGH_ANCHORS })).toBe(130);
    expect(deriveFromAnchors({ exerciseName: 'Leg Extension', anchorWorkingWeights: LOW_ANCHORS })).toBe(20);
    expect(deriveFromAnchors({ exerciseName: 'Leg Extension', anchorWorkingWeights: HIGH_ANCHORS })).toBe(45);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Lunges', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Lunges', anchorWorkingWeights: HIGH_ANCHORS })).toBe(20);
  });

  it('Hamstrings: Leg Curl, RDL, Hip Thrust', () => {
    expect(deriveFromAnchors({ exerciseName: 'Leg Curl', anchorWorkingWeights: LOW_ANCHORS })).toBe(20);
    expect(deriveFromAnchors({ exerciseName: 'Leg Curl', anchorWorkingWeights: HIGH_ANCHORS })).toBe(40);
    // RDL: barbell, no floor — same "known edge case" as Upright Row above.
    expect(deriveFromAnchors({ exerciseName: 'Romanian Deadlift', anchorWorkingWeights: LOW_ANCHORS })).toBe(15);
    expect(deriveFromAnchors({ exerciseName: 'Romanian Deadlift', anchorWorkingWeights: HIGH_ANCHORS })).toBe(97.5);
    expect(deriveFromAnchors({ exerciseName: 'Hip Thrust', anchorWorkingWeights: LOW_ANCHORS })).toBe(25);
    expect(deriveFromAnchors({ exerciseName: 'Hip Thrust', anchorWorkingWeights: HIGH_ANCHORS })).toBe(170);
  });

  it('Biceps: Barbell Curl, DB Curl, Cable Curl', () => {
    expect(deriveFromAnchors({ exerciseName: 'Barbell Curl', anchorWorkingWeights: LOW_ANCHORS })).toBe(15);
    expect(deriveFromAnchors({ exerciseName: 'Barbell Curl', anchorWorkingWeights: HIGH_ANCHORS })).toBe(25);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Curl', anchorWorkingWeights: LOW_ANCHORS })).toBe(7.5);
    expect(deriveFromAnchors({ exerciseName: 'Dumbbell Curl', anchorWorkingWeights: HIGH_ANCHORS })).toBe(12.5);
    expect(deriveFromAnchors({ exerciseName: 'Cable Curl', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Cable Curl', anchorWorkingWeights: HIGH_ANCHORS })).toBe(20);
  });

  it('Triceps: Pushdown, Overhead Extension, Kickback', () => {
    expect(deriveFromAnchors({ exerciseName: 'Tricep Pushdown', anchorWorkingWeights: LOW_ANCHORS })).toBe(20);
    expect(deriveFromAnchors({ exerciseName: 'Tricep Pushdown', anchorWorkingWeights: HIGH_ANCHORS })).toBe(22.5);
    expect(deriveFromAnchors({ exerciseName: 'Overhead Tricep Extension', anchorWorkingWeights: LOW_ANCHORS })).toBe(10);
    expect(deriveFromAnchors({ exerciseName: 'Overhead Tricep Extension', anchorWorkingWeights: HIGH_ANCHORS })).toBe(15);
    expect(deriveFromAnchors({ exerciseName: 'Tricep Kickback', anchorWorkingWeights: LOW_ANCHORS })).toBe(5);
    expect(deriveFromAnchors({ exerciseName: 'Tricep Kickback', anchorWorkingWeights: HIGH_ANCHORS })).toBe(7.5);
  });

  it('Calves: Seated/Standing Calf Raise — floor at LOW, ratio ~1.0x squat at HIGH', () => {
    // Flagged as the map's softest correlation (squat doesn't strongly
    // predict calf-raise capacity) — the floor carries LOW; ratio 1.0
    // means HIGH tracks the squat anchor roughly 1:1, which is still
    // conservative against commonly observed 1.5x+ multipliers but no
    // longer reads as broken (the old 0.45 gave a 100kg squatter only
    // 45kg on a calf-raise machine).
    expect(deriveFromAnchors({ exerciseName: 'Seated Calf Raise', anchorWorkingWeights: LOW_ANCHORS })).toBe(40);
    expect(deriveFromAnchors({ exerciseName: 'Seated Calf Raise', anchorWorkingWeights: HIGH_ANCHORS })).toBe(100);
    expect(deriveFromAnchors({ exerciseName: 'Standing Calf Raise', anchorWorkingWeights: LOW_ANCHORS })).toBe(40);
    expect(deriveFromAnchors({ exerciseName: 'Standing Calf Raise', anchorWorkingWeights: HIGH_ANCHORS })).toBe(100);
  });
});

describe('deriveFromAnchors — null-when-anchor-missing behavior', () => {
  it('returns null when the exercise is not in the derivation map', () => {
    expect(deriveFromAnchors({ exerciseName: 'Nonexistent Exercise', anchorWorkingWeights: ANCHORS })).toBeNull();
  });

  it('returns null when the mapped anchor is missing from anchorWorkingWeights', () => {
    // Incline Bench maps to 'bench' — omit it.
    const { bench, ...withoutBench } = ANCHORS;
    expect(deriveFromAnchors({ exerciseName: 'Incline Barbell Bench Press', anchorWorkingWeights: withoutBench })).toBeNull();
  });

  it('returns null for a zero or negative anchor weight (defensive — should never happen upstream)', () => {
    expect(deriveFromAnchors({ exerciseName: 'Incline Barbell Bench Press', anchorWorkingWeights: { bench: 0 } })).toBeNull();
    expect(deriveFromAnchors({ exerciseName: 'Incline Barbell Bench Press', anchorWorkingWeights: { bench: -10 } })).toBeNull();
  });

  it('returns null with a completely empty anchorWorkingWeights map', () => {
    expect(deriveFromAnchors({ exerciseName: 'Incline Barbell Bench Press', anchorWorkingWeights: {} })).toBeNull();
  });

  it('the five anchor exercises themselves are never derivation targets', () => {
    // If the user has no history for Barbell Squat, there is by
    // definition no squat anchorWorkingWeight to derive it FROM either —
    // these are deliberately excluded from the map, not just naturally
    // null.
    for (const def of ANCHOR_LIFTS) {
      expect(deriveFromAnchors({ exerciseName: def.exerciseName, anchorWorkingWeights: ANCHORS })).toBeNull();
    }
  });
});

describe('deriveFromAnchors — deliberately excluded categories', () => {
  it('bodyweight-equipment exercises are never in the map (the Coach\'s Call never engages for them anyway)', () => {
    const bodyweightNames = EXERCISES.filter(e => e.equipment === 'bodyweight').map(e => e.name);
    expect(bodyweightNames.length).toBeGreaterThan(0);
    for (const name of bodyweightNames) {
      expect(deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: ANCHORS })).toBeNull();
    }
  });

  it('ab/core work is never in the map — no anchor has a defensible relationship to trunk flexion', () => {
    const coreNames = EXERCISES.filter(e => e.category === 'core').map(e => e.name);
    expect(coreNames.length).toBeGreaterThan(0);
    for (const name of coreNames) {
      expect(deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: ANCHORS })).toBeNull();
    }
  });
});

describe('deriveFromAnchors — calf raises ARE mapped (product call, floor-dominated)', () => {
  it('Seated Calf Raise and Standing Calf Raise derive from squat, not null', () => {
    // Reverses the PRIOR "calves excluded" stance from an earlier pass —
    // the product wants a floor-backed number here over a blank box,
    // even though squat strength only weakly predicts calf-raise
    // capacity. See the map-level docstring in anchorDerivation.ts.
    const calfNames = EXERCISES.filter(e => e.primaryMuscle === 'calves' && e.equipment !== 'bodyweight').map(e => e.name);
    expect(calfNames.length).toBeGreaterThan(0);
    for (const name of calfNames) {
      expect(basisForExercise(name)).toBe('squat');
      expect(deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: ANCHORS })).not.toBeNull();
    }
  });
});

describe('deriveFromAnchors — isolation ratios stay sensibly light, never forced near the anchor', () => {
  it('every mapped isolation exercise derives to well under its anchor working weight', () => {
    // Calf raises are catalogued as movement: 'isolation' (single-joint,
    // ankle-only) but are DELIBERATELY excluded from this "stays light"
    // check — a calf-raise machine routinely moves as much or more than
    // a lifter's squat (short ROM, strong muscle group), so ratio 1.0 is
    // correct here even though it's the opposite of "sensibly light."
    // See the ratio's doc comment in anchorDerivation.ts.
    const isolationNames = EXERCISES
      .filter(e => e.movement === 'isolation' && e.primaryMuscle !== 'calves')
      .map(e => e.name);
    for (const name of isolationNames) {
      const kg = deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: ANCHORS });
      if (kg == null) continue; // not every isolation exercise is mapped (abs)
      const basis = basisForExercise(name)!;
      const anchorWeight = ANCHORS[basis];
      // "Sensibly light" — under 55% of the anchor's own working weight
      // for every isolation movement in the map (compounds like Leg
      // Press/Hip Thrust are intentionally excluded from this check —
      // they're compounds that legitimately exceed their anchor).
      expect(kg).toBeLessThan(anchorWeight * 0.55);
    }
  });

  it('calf raises are the deliberate exception: ratio ~1.0 means they can equal or exceed the squat anchor', () => {
    const kg = deriveFromAnchors({ exerciseName: 'Seated Calf Raise', anchorWorkingWeights: ANCHORS })!;
    expect(kg).toBeGreaterThanOrEqual(ANCHORS.squat * 0.9);
  });
});

describe('basisForExercise + ANCHOR_BASIS_LABEL', () => {
  it('returns the anchor key a mapped exercise derives from', () => {
    expect(basisForExercise('Incline Barbell Bench Press')).toBe('bench');
    expect(basisForExercise('Lateral Raise')).toBe('overhead');
    expect(basisForExercise('Lat Pulldown')).toBe('row');
    expect(basisForExercise('Leg Press')).toBe('squat');
    expect(basisForExercise('Leg Curl')).toBe('deadlift');
  });

  it('returns null for an unmapped exercise', () => {
    expect(basisForExercise('Plank')).toBeNull();
  });

  it('every AnchorLiftKey has a display label, and every basis label is non-empty', () => {
    for (const def of ANCHOR_LIFTS) {
      expect(ANCHOR_BASIS_LABEL[def.key]).toBeTruthy();
    }
  });

  it('is consistent with deriveFromAnchors: basisForExercise names the SAME anchor deriveFromAnchors actually used', () => {
    const mappedNames = EXERCISES
      .map(e => e.name)
      .filter(name => basisForExercise(name) !== null);
    expect(mappedNames.length).toBeGreaterThan(0);
    for (const name of mappedNames) {
      const basis = basisForExercise(name)!;
      // Anchor every basis at a large value so every ratio produces a
      // positive, non-null result regardless of how small the ratio is.
      const allAnchored = { bench: 1000, squat: 1000, deadlift: 1000, overhead: 1000, row: 1000 };
      const kg = deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: allAnchored });
      expect(kg).not.toBeNull();
      // Zeroing out ONLY the named basis must make it null again — proves
      // the label truthfully reflects which key drives the number.
      const withoutBasis = { ...allAnchored, [basis]: undefined };
      expect(deriveFromAnchors({ exerciseName: name, anchorWorkingWeights: withoutBasis })).toBeNull();
    }
  });
});

describe('buildAnchorWorkingWeights', () => {
  it('builds an AnchorLiftKey-keyed map from canonical exercise names', () => {
    const byName = {
      'Barbell Bench Press': 82.5,
      'Barbell Squat': 107.5,
      'Deadlift': 142.5,
      'Overhead Press': 45,
      'Barbell Row': 62.5,
    };
    expect(buildAnchorWorkingWeights(byName, ANCHOR_LIFTS)).toEqual(ANCHORS);
  });

  it('omits anchors with no entry or a non-positive weight', () => {
    const byName = {
      'Barbell Bench Press': 82.5,
      'Barbell Squat': 0,
      'Deadlift': -5,
      // Overhead Press and Barbell Row absent entirely.
    };
    expect(buildAnchorWorkingWeights(byName, ANCHOR_LIFTS)).toEqual({ bench: 82.5 });
  });

  it('returns an empty object when nothing is anchored', () => {
    expect(buildAnchorWorkingWeights({}, ANCHOR_LIFTS)).toEqual({});
  });
});
