import {
  goalReps,
  goalRest,
  goalSets,
  parseBand,
  nextVolumeStep,
  type Goal,
} from './goalProfile';
import { deloadReps, deloadSets } from './planGeneration';

describe('parseBand', () => {
  it('parses a canonical X-Y band', () => {
    expect(parseBand('8-12')).toEqual({ min: 8, max: 12 });
  });
  it('tolerates whitespace', () => {
    expect(parseBand(' 6 - 10 ')).toEqual({ min: 6, max: 10 });
  });
  it('rejects the time-under-tension edge case', () => {
    // "30-60s" is a real catalog value for planks / calf holds — must NOT
    // parse, so goalReps / progression code can't corrupt it.
    expect(parseBand('30-60s')).toBeNull();
  });
  it('rejects a single-number string', () => {
    expect(parseBand('10')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(parseBand('AMRAP')).toBeNull();
    expect(parseBand('')).toBeNull();
    expect(parseBand('12-8')).toBeNull(); // inverted band
  });
});

describe('goalReps', () => {
  // Compound × 3 lanes
  it('strength compound → 3-5', () => {
    expect(goalReps('8-12', 'strength', true)).toBe('3-5');
    expect(goalReps('5-8', 'strength', true)).toBe('3-5');
  });
  it('muscle compound → 6-10', () => {
    expect(goalReps('8-12', 'muscle', true)).toBe('6-10');
  });
  it('general is a pure passthrough on compounds (no dose change)', () => {
    // General used to be reinterpreted as a "blended default" (5-8 compound).
    // Reverted: existing users on the default lane see NO change.
    expect(goalReps('8-12', 'general', true)).toBe('8-12');
    expect(goalReps('5-10', 'general', true)).toBe('5-10');
  });

  // Isolation × 3 lanes
  it('strength isolation → 8-10', () => {
    // Tuned from 6-8 to 8-10 for elbow / shoulder tolerance on curls,
    // raises, extensions. Still lower-rep than muscle/general.
    expect(goalReps('12-15', 'strength', false)).toBe('8-10');
  });
  it('muscle isolation → 10-15', () => {
    expect(goalReps('12-15', 'muscle', false)).toBe('10-15');
  });
  it('general is a pure passthrough on isolations too', () => {
    expect(goalReps('12-15', 'general', false)).toBe('12-15');
    expect(goalReps('10-12', 'general', false)).toBe('10-12');
  });

  // Fall-throughs
  it('passes catalog value through when goal is undefined / null', () => {
    expect(goalReps('8-12', undefined, true)).toBe('8-12');
    expect(goalReps('8-12', null, true)).toBe('8-12');
  });
  it('passes catalog value through on unknown goal string', () => {
    expect(goalReps('8-12', 'nonsense' as unknown as Goal, true)).toBe('8-12');
  });
  it('passes the "30-60s" edge case through untouched on any lane', () => {
    // Time-under-tension catalog entry: engine must not corrupt it.
    for (const g of ['strength', 'muscle', 'general'] as const) {
      expect(goalReps('30-60s', g, false)).toBe('30-60s');
    }
  });
});

describe('goalRest', () => {
  it('strength: compound 210s, isolation 120s', () => {
    expect(goalRest(90, 'strength', true)).toBe(210);
    expect(goalRest(60, 'strength', false)).toBe(120);
  });
  it('muscle: compound 120s, isolation 75s', () => {
    expect(goalRest(90, 'muscle', true)).toBe(120);
    expect(goalRest(60, 'muscle', false)).toBe(75);
  });
  it('general is a pure passthrough on rest', () => {
    expect(goalRest(90, 'general', true)).toBe(90);
    expect(goalRest(60, 'general', false)).toBe(60);
    expect(goalRest(120, 'general', true)).toBe(120);
  });
  it('passes catalog value through when goal is missing', () => {
    expect(goalRest(90, undefined, true)).toBe(90);
    expect(goalRest(60, null, false)).toBe(60);
  });
});

describe('goalSets', () => {
  it('strength keeps sets flat across weeks 1-3 (progression is load, not volume)', () => {
    for (let wk = 1; wk <= 3; wk++) {
      expect(goalSets(4, 'strength', true, wk)).toBe(4);
      expect(goalSets(3, 'strength', false, wk)).toBe(3);
    }
  });

  it('muscle compounds stay flat (set climb on a heavy compound explodes session length)', () => {
    for (let wk = 1; wk <= 3; wk++) {
      expect(goalSets(4, 'muscle', true, wk)).toBe(4);
    }
  });

  it('general is a pure passthrough on sets across every week (no volume climb)', () => {
    for (let wk = 1; wk <= 3; wk++) {
      expect(goalSets(4, 'general', true, wk)).toBe(4);
      expect(goalSets(3, 'general', false, wk)).toBe(3);
    }
  });

  it('muscle isolation adds a set in weeks 2 and 3', () => {
    expect(goalSets(3, 'muscle', false, 1)).toBe(3);
    expect(goalSets(3, 'muscle', false, 2)).toBe(4);
    expect(goalSets(3, 'muscle', false, 3)).toBe(4);
  });

  it('general isolation stays flat too — no set climb (passthrough contract)', () => {
    expect(goalSets(3, 'general', false, 1)).toBe(3);
    expect(goalSets(3, 'general', false, 2)).toBe(3);
    expect(goalSets(3, 'general', false, 3)).toBe(3);
  });

  it('passes catalog value through when goal is missing', () => {
    expect(goalSets(3, undefined, false, 2)).toBe(3);
  });

  it('clamps out-of-range blockWeek to week 1 (defensive)', () => {
    // blockWeek === 4 is the deload; callers apply deloadSets on top of
    // this baseline, so goalSets treats it as week 1 (baseline).
    expect(goalSets(3, 'muscle', false, 4)).toBe(3);
    expect(goalSets(3, 'muscle', false, 0)).toBe(3);
    expect(goalSets(3, 'muscle', false, -5)).toBe(3);
  });

  it('floors non-positive catalog input at 1', () => {
    expect(goalSets(0, 'muscle', false, 2)).toBe(1);
    expect(goalSets(-3, 'muscle', false, 2)).toBe(1);
  });
});

// ── Deload stacks on top of goal ─────────────────────────────────────────
// The generator applies goal FIRST, then deload. Verify the composition
// produces sensible numbers for a "hard" case: muscle compound catalog 8-12
// → goal 6-10 → deload 8-12; muscle isolation 4 sets → goal 5 sets in wk3
// → deload ceil(5*0.6) = 3.

describe('goal + deload composition', () => {
  it('muscle compound: 8-12 catalog → 6-10 goal → 8-12 deload', () => {
    const g = goalReps('8-12', 'muscle', true);
    expect(g).toBe('6-10');
    expect(deloadReps(g)).toBe('8-12');
  });
  it('strength compound: 8-12 catalog → 3-5 goal → 5-7 deload', () => {
    const g = goalReps('8-12', 'strength', true);
    expect(g).toBe('3-5');
    expect(deloadReps(g)).toBe('5-7');
  });
  it('general isolation: catalog value flows through, deload applies unchanged', () => {
    // Passthrough — general returns catalog unchanged, then deload adds
    // +2 to each end same as it would on any raw catalog value.
    const g = goalReps('12-15', 'general', false);
    expect(g).toBe('12-15');
    expect(deloadReps(g)).toBe('14-17');
  });
  it('sets: goal week-3 climb then deload applies cleanly', () => {
    // Muscle isolation, catalog 3 sets, wk3 goal → 4 sets, deload → 3 sets.
    const g = goalSets(3, 'muscle', false, 3);
    expect(g).toBe(4);
    expect(deloadSets(g)).toBe(3);
  });
});

// ── Volume-first progression ─────────────────────────────────────────────

describe('nextVolumeStep', () => {
  const musCompound = { band: { min: 6, max: 10 }, goal: 'muscle' as Goal, isCompound: true };
  const musIso = { band: { min: 10, max: 15 }, goal: 'muscle' as Goal, isCompound: false };
  const strCompound = { band: { min: 3, max: 5 }, goal: 'strength' as Goal, isCompound: true };
  const genIso = { band: { min: 10, max: 15 }, goal: 'general' as Goal, isCompound: false };

  it('no history → aim for top of band (both lanes)', () => {
    expect(nextVolumeStep({ ...musIso, lastReps: null, lastRir: null })).toEqual({
      targetReps: 15, readyForLoadBump: false,
    });
    expect(nextVolumeStep({ ...strCompound, lastReps: null, lastRir: null })).toEqual({
      targetReps: 5, readyForLoadBump: false,
    });
  });

  it('strength: aim is always top of band (progression is load-side)', () => {
    expect(nextVolumeStep({ ...strCompound, lastReps: 3, lastRir: 3 }).targetReps).toBe(5);
    expect(nextVolumeStep({ ...strCompound, lastReps: 4, lastRir: 2 }).targetReps).toBe(5);
  });

  it('strength ready for load bump when reps hit top at RIR 1, 2, or 3 (full target zone)', () => {
    expect(nextVolumeStep({ ...strCompound, lastReps: 5, lastRir: 3 }).readyForLoadBump).toBe(true);
    expect(nextVolumeStep({ ...strCompound, lastReps: 5, lastRir: 2 }).readyForLoadBump).toBe(true);
    // RIR 1 is now on-target for strength (clean set with one in the tank)
    // — the RIR-1 bug fix widened the ready-to-progress signal.
    expect(nextVolumeStep({ ...strCompound, lastReps: 5, lastRir: 1 }).readyForLoadBump).toBe(true);
    // RIR 0 is failure — not ready.
    expect(nextVolumeStep({ ...strCompound, lastReps: 5, lastRir: 0 }).readyForLoadBump).toBe(false);
  });

  it('muscle: reps climb by 1 while under the band top', () => {
    expect(nextVolumeStep({ ...musIso, lastReps: 10, lastRir: 2 })).toEqual({
      targetReps: 11, readyForLoadBump: false,
    });
    expect(nextVolumeStep({ ...musIso, lastReps: 12, lastRir: 1 })).toEqual({
      targetReps: 13, readyForLoadBump: false,
    });
  });

  it('muscle: hitting top of band cleanly resets to band.min and flags load bump', () => {
    expect(nextVolumeStep({ ...musIso, lastReps: 15, lastRir: 1 })).toEqual({
      targetReps: 10, readyForLoadBump: true,
    });
  });

  it('muscle: grinded top-of-band rep (RIR 0) holds, does NOT flag load bump', () => {
    expect(nextVolumeStep({ ...musIso, lastReps: 15, lastRir: 0 })).toEqual({
      targetReps: 15, readyForLoadBump: false,
    });
  });

  it('general: aims for top of band, never claims load-bump readiness (passthrough)', () => {
    // General is a pure passthrough — nextVolumeStep never triggers a
    // rep-based load bump. Weight decisions defer to prescribeLoad's
    // pre-goal RIR ladder. Same output shape as the strength / unknown
    // branch: aim for band.max, readyForLoadBump: false.
    expect(nextVolumeStep({ ...genIso, lastReps: 15, lastRir: 1 })).toEqual({
      targetReps: 15, readyForLoadBump: false,
    });
    expect(nextVolumeStep({ ...genIso, lastReps: 10, lastRir: 2 })).toEqual({
      targetReps: 15, readyForLoadBump: false,
    });
  });

  it('overshoot in the log is clamped to band.max on the +1 nudge', () => {
    // User logged 14 in a 10-12 band (rep miscount). Next target caps at 12.
    expect(nextVolumeStep({
      band: { min: 10, max: 12 }, goal: 'muscle', isCompound: false,
      lastReps: 11, lastRir: 2,
    }).targetReps).toBe(12);
  });

  it('muscle compound honors the same top-of-band gate', () => {
    expect(nextVolumeStep({ ...musCompound, lastReps: 8, lastRir: 2 }).targetReps).toBe(9);
    expect(nextVolumeStep({ ...musCompound, lastReps: 10, lastRir: 2 })).toEqual({
      targetReps: 6, readyForLoadBump: true,
    });
  });

  it('unknown goal falls through to the strength-style "aim for top" default', () => {
    expect(nextVolumeStep({
      band: { min: 8, max: 12 }, goal: undefined, isCompound: false,
      lastReps: 8, lastRir: 2,
    }).targetReps).toBe(12);
  });
});
