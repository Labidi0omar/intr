/// <reference types="node" />
// generateAdHocDay — single-day generator used by the "Train anyway" path
// on the rest-day / no-plan error screen.
//
// What we guard:
//   - Every supported AdHocWorkoutType produces a PlanDay whose workoutType
//     label matches the user's selection (Push → 'Push', Lower → 'Lower',
//     etc.). The mapping from (split, dayIndexOffset) to dayType must stay
//     correct or the user gets a different workout than they tapped.
//   - The returned day has non-empty exercises so the pre-screen renders.
//   - The day's date snaps to the supplied startDate so finishWorkout writes
//     against today, not the generator's default anchor.

import { generateAdHocDay, type AdHocWorkoutType } from './planGeneration';

const TODAY = '2026-06-08'; // arbitrary fixed Monday

describe('generateAdHocDay — label and shape', () => {
  const cases: AdHocWorkoutType[] = ['Push', 'Pull', 'Legs', 'Upper', 'Lower', 'Full Body'];

  for (const type of cases) {
    it(`${type} → returns a PlanDay labelled "${type}" with exercises`, () => {
      const day = generateAdHocDay({
        workoutType: type,
        location: 'gym',
        fitnessLevel: 'intermediate',
        startDate: TODAY,
      });
      expect(day).not.toBeNull();
      expect(day!.workoutType).toBe(type);
      expect(day!.exercises.length).toBeGreaterThan(0);
      // Date snaps to the requested start so the session writes to today.
      expect(day!.date).toBe(TODAY);
    });
  }
});

describe('generateAdHocDay — selection knobs', () => {
  it('respects location: home filters out gym-only exercises', () => {
    const home = generateAdHocDay({
      workoutType: 'Push',
      location: 'home',
      fitnessLevel: 'beginner',
      startDate: TODAY,
    });
    expect(home).not.toBeNull();
    expect(home!.exercises.length).toBeGreaterThan(0);
    // Every picked exercise must have been a home-valid one. We assert via
    // the equipment heuristic: machine/cable exercises are gym-only and
    // shouldn't appear in a home pick.
    for (const ex of home!.exercises) {
      const eq = (ex.equipment ?? '').toLowerCase();
      expect(eq).not.toMatch(/^cable$/);
      expect(eq).not.toMatch(/^machine$/);
    }
  });

  it('blockIndex N+1 keeps the isPrimary anchors stable for the same type', () => {
    // CONTRACT (v5): selection ranks by balanced score, with isPrimary
    // anchors held stable across blocks (they're the progression anchors —
    // bench, press, etc. — and must not rotate). Ad-hoc has no
    // planHistory pressure, so the score-ranked top-N is identical from
    // block to block. The previous v3/v4 contract that reshuffled every
    // slot across blocks no longer holds — see info/exercise-ranking.md.
    const a = generateAdHocDay({
      workoutType: 'Push',
      location: 'gym',
      fitnessLevel: 'intermediate',
      blockIndex: 0,
      startDate: TODAY,
    });
    const b = generateAdHocDay({
      workoutType: 'Push',
      location: 'gym',
      fitnessLevel: 'intermediate',
      blockIndex: 1,
      startDate: TODAY,
    });
    const aNames = a!.exercises.map(e => e.name);
    const bNames = b!.exercises.map(e => e.name);
    expect(aNames.length).toBe(bNames.length);
    // Anchors must persist: Barbell Bench (chest PRIMARY) and Overhead
    // Press (shoulders PRIMARY) appear in both.
    expect(aNames).toContain('Barbell Bench Press');
    expect(bNames).toContain('Barbell Bench Press');
    expect(aNames).toContain('Overhead Press');
    expect(bNames).toContain('Overhead Press');
  });

  it('within the same block, repeated calls return identical exercises', () => {
    // Determinism guarantee: tapping "Push" twice on the same day in the
    // same block produces the same workout. Avoids the legacy Math.random
    // jitter that would have shown a different session on every navigation.
    const a = generateAdHocDay({
      workoutType: 'Pull',
      location: 'gym',
      fitnessLevel: 'intermediate',
      blockIndex: 0,
      startDate: TODAY,
    });
    const b = generateAdHocDay({
      workoutType: 'Pull',
      location: 'gym',
      fitnessLevel: 'intermediate',
      blockIndex: 0,
      startDate: TODAY,
    });
    expect(b!.exercises.map(e => e.name)).toEqual(a!.exercises.map(e => e.name));
  });
});
