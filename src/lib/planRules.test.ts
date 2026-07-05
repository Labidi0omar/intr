/// <reference types="node" />
// planRules — the principled goal-aware structure engine for the strength
// and muscle lanes. This suite pins:
//   1. Weekly-peak table values (Table 1).
//   2. Per-muscle-per-session cap semantics (Table 5) — including the
//      deliberate advanced-strength clamp at 10.
//   3. Ramp curve derived FROM the peak, not on top of it (Cases A–D).
//   4. Compound stays flat; ramp lives on isolation slots.
//   5. Deload distributes across slots (never zeroes one out).
//   6. Determinism substrate: slot IDENTITY is fixed across blockWeeks 1–3
//      (only per-slot sets vary).
//
// The four approved cases are the load-bearing fixtures. If any of them
// shift, the design decision moved — update this file with the same
// rigor that produced it, not by editing a single expectation.

import {
  buildDayStructure,
  computeFrequency,
  isEngineSupportedDayType,
  muscleTier,
  rampTargetSets,
  sessionPeakSets,
  weeklyPeakSets,
  PLAN_RULES_TABLES,
  type BlockWeek,
  type DayStructure,
} from './planRules';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Sum the peakSets across every slot in a day. wk3 is the peak. */
function totalPeakSets(day: DayStructure): number {
  let s = 0;
  for (const m of day.muscles) for (const slot of m.slots) s += slot.setsByWeek[3];
  return s;
}

/** Find the muscle group's slots (or null when the muscle isn't in the day). */
function slotsFor(day: DayStructure, muscle: string) {
  return day.muscles.find(m => m.muscle === muscle)?.slots ?? null;
}

// ── Table 1 & Muscle tier ────────────────────────────────────────────────

describe('muscleTier + weeklyPeakSets (Table 1 values)', () => {
  it('classifies major vs small muscles', () => {
    expect(muscleTier('chest')).toBe('major');
    expect(muscleTier('quads')).toBe('major');
    expect(muscleTier('glutes')).toBe('major');
    expect(muscleTier('biceps')).toBe('small');
    expect(muscleTier('triceps')).toBe('small');
    expect(muscleTier('rear delts')).toBe('small');
    expect(muscleTier('calves')).toBe('small');
    // Unknown muscles → null (engine will skip; caller falls through).
    expect(muscleTier('forearms')).toBeNull();
    expect(muscleTier('')).toBeNull();
  });

  it('Table 1 — weekly PEAK sets per lane × level × tier', () => {
    // Strength lane (major / small)
    expect(weeklyPeakSets('strength', 'beginner',     'major')).toBe(8);
    expect(weeklyPeakSets('strength', 'intermediate', 'major')).toBe(10);
    expect(weeklyPeakSets('strength', 'advanced',     'major')).toBe(12);
    expect(weeklyPeakSets('strength', 'beginner',     'small')).toBe(6);
    expect(weeklyPeakSets('strength', 'intermediate', 'small')).toBe(8);
    expect(weeklyPeakSets('strength', 'advanced',     'small')).toBe(8);
    // Muscle lane (major / small)
    expect(weeklyPeakSets('muscle', 'beginner',     'major')).toBe(10);
    expect(weeklyPeakSets('muscle', 'intermediate', 'major')).toBe(14);
    expect(weeklyPeakSets('muscle', 'advanced',     'major')).toBe(18);
    expect(weeklyPeakSets('muscle', 'beginner',     'small')).toBe(8);
    expect(weeklyPeakSets('muscle', 'intermediate', 'small')).toBe(12);
    expect(weeklyPeakSets('muscle', 'advanced',     'small')).toBe(14);
  });
});

// ── Frequency ────────────────────────────────────────────────────────────

describe('computeFrequency across splits', () => {
  it('bro_split 5-day: one muscle per day (freq=1)', () => {
    expect(computeFrequency('bro_split', 5, 'chest')).toBe(1);
    expect(computeFrequency('bro_split', 5, 'back')).toBe(1);
    expect(computeFrequency('bro_split', 5, 'biceps')).toBe(1);
    expect(computeFrequency('bro_split', 5, 'triceps')).toBe(1);
    // Rear delts appear on shoulders day only in the new engine (removed
    // from back day accessory — intentional; one-muscle-a-day).
    expect(computeFrequency('bro_split', 5, 'rear delts')).toBe(1);
  });

  it('ppl 3-day: each muscle hit exactly once per week', () => {
    expect(computeFrequency('ppl', 3, 'chest')).toBe(1);
    expect(computeFrequency('ppl', 3, 'back')).toBe(1);
    expect(computeFrequency('ppl', 3, 'quads')).toBe(1);
    expect(computeFrequency('ppl', 3, 'triceps')).toBe(1);
    expect(computeFrequency('ppl', 3, 'biceps')).toBe(1);
  });

  it('ppl 6-day: each muscle hit twice per week', () => {
    expect(computeFrequency('ppl', 6, 'chest')).toBe(2);
    expect(computeFrequency('ppl', 6, 'back')).toBe(2);
    expect(computeFrequency('ppl', 6, 'quads')).toBe(2);
    expect(computeFrequency('ppl', 6, 'triceps')).toBe(2);
  });

  it('upper_lower 4-day: each half twice per week', () => {
    expect(computeFrequency('upper_lower', 4, 'chest')).toBe(2);
    expect(computeFrequency('upper_lower', 4, 'quads')).toBe(2);
    // biceps / triceps aren't on the upper day in the new engine (indirect
    // exposure only from press / row compounds).
    expect(computeFrequency('upper_lower', 4, 'biceps')).toBe(0);
  });

  it('full_body 3-day: full-body muscles trained 3x/wk', () => {
    expect(computeFrequency('full_body', 3, 'chest')).toBe(3);
    expect(computeFrequency('full_body', 3, 'quads')).toBe(3);
  });
});

// ── Session peak sets (Table 1 + Table 5 clamp) ──────────────────────────

describe('sessionPeakSets — Table 5 cap semantics', () => {
  it('advanced muscle · PPL 6-day chest (freq=2): peak 18 → session 9 (under cap 10)', () => {
    expect(sessionPeakSets('chest', 'muscle', 'advanced', 2)).toBe(9);
  });

  it('advanced muscle · bro-split chest (freq=1): peak 18 → session 10 (cap 10 bites hard)', () => {
    // Case C — worst-case junk-volume risk; the cap protects the session.
    expect(sessionPeakSets('chest', 'muscle', 'advanced', 1)).toBe(10);
  });

  it('intermediate muscle · bro-split biceps (freq=1): peak 12 → session 8 (cap 8)', () => {
    // Case B — small-muscle cap clamps 12 to 8.
    expect(sessionPeakSets('biceps', 'muscle', 'intermediate', 1)).toBe(8);
  });

  it('advanced STRENGTH · freq-1 splits: major peak 12 → SILENTLY capped at 10', () => {
    // Deliberate design call — 10 quality heavy sets is plenty of strength
    // stimulus in one day, and sets 11–12 in a single session add little.
    // The "advanced strength" tier's extra weekly volume is unreachable on
    // low-frequency splits by design. This fixture locks the clamp.
    expect(sessionPeakSets('chest', 'strength', 'advanced', 1)).toBe(10);
    expect(sessionPeakSets('back',  'strength', 'advanced', 1)).toBe(10);
    expect(sessionPeakSets('quads', 'strength', 'advanced', 1)).toBe(10);
    // Weekly target itself is unchanged — the cap is where the clamp lives.
    expect(weeklyPeakSets('strength', 'advanced', 'major')).toBe(12);
  });

  it('unknown muscle or zero frequency → 0 (caller falls through)', () => {
    expect(sessionPeakSets('forearms', 'muscle', 'intermediate', 1)).toBe(0);
    expect(sessionPeakSets('chest', 'muscle', 'intermediate', 0)).toBe(0);
  });
});

// ── Ramp curve (peak-2 / peak-1 / peak / deload) ─────────────────────────

describe('rampTargetSets — Table 4 curve derived FROM the peak', () => {
  it('strength lane: FLAT weeks 1–3, deload week 4', () => {
    expect(rampTargetSets(10, 'strength', 1)).toBe(10);
    expect(rampTargetSets(10, 'strength', 2)).toBe(10);
    expect(rampTargetSets(10, 'strength', 3)).toBe(10);
    // deloadSets(10) = ceil(10 * 0.6) = 6
    expect(rampTargetSets(10, 'strength', 4)).toBe(6);
  });

  it('muscle lane: peak-2 / peak-1 / peak / deload — the interpolate-down curve', () => {
    // sessionPeak 9 (Case A chest)
    expect(rampTargetSets(9, 'muscle', 1)).toBe(7);
    expect(rampTargetSets(9, 'muscle', 2)).toBe(8);
    expect(rampTargetSets(9, 'muscle', 3)).toBe(9);
    // deloadSets(9) = ceil(9 * 0.6) = 6
    expect(rampTargetSets(9, 'muscle', 4)).toBe(6);
  });

  it('muscle lane clamped-to-cap peak (10) still interpolates: 8/9/10/6', () => {
    // Case B chest — the cap already bit; ramp starts from the capped peak.
    expect(rampTargetSets(10, 'muscle', 1)).toBe(8);
    expect(rampTargetSets(10, 'muscle', 2)).toBe(9);
    expect(rampTargetSets(10, 'muscle', 3)).toBe(10);
    expect(rampTargetSets(10, 'muscle', 4)).toBe(6);
  });

  it('muscle lane floors at 2 sets on tiny peaks (never dips into "priming set only")', () => {
    expect(rampTargetSets(3, 'muscle', 1)).toBe(2);
    expect(rampTargetSets(3, 'muscle', 2)).toBe(2);
    expect(rampTargetSets(3, 'muscle', 3)).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CASE FIXTURES — the four load-bearing configurations approved before
// implementation. Any drift here means the design moved.
// ══════════════════════════════════════════════════════════════════════════

describe('CASE A — advanced muscle · PPL 6-day (freq = 2)', () => {
  const build = (dayType: string) => buildDayStructure({
    goal: 'muscle', dayType, location: 'gym', level: 'advanced',
    split: 'ppl', trainingDays: 6,
  })!;

  it('push day: chest 9 / shoulders 9 / triceps 7 sets at wk3 peak; day total ≤ 30', () => {
    const day = build('push');
    // Per-muscle session peaks match the case table:
    //   chest      weekly 18 / freq 2 = 9 (cap 10, no clamp)
    //   shoulders  weekly 18 / freq 2 = 9 (cap 10, no clamp)
    //   triceps    weekly 14 / freq 2 = 7 (cap 8,  no clamp)
    const chest = slotsFor(day, 'chest');
    const shoulders = slotsFor(day, 'shoulders');
    const triceps = slotsFor(day, 'triceps');
    expect(chest).not.toBeNull();
    expect(shoulders).not.toBeNull();
    expect(triceps).not.toBeNull();
    const chestPeak = chest!.reduce((a, s) => a + s.setsByWeek[3], 0);
    const shouldersPeak = shoulders!.reduce((a, s) => a + s.setsByWeek[3], 0);
    const tricepsPeak = triceps!.reduce((a, s) => a + s.setsByWeek[3], 0);
    expect(chestPeak).toBe(9);
    expect(shouldersPeak).toBe(9);
    expect(tricepsPeak).toBe(7);
    // Whole-session cap sanity — session cap is 30 for muscle; this day
    // sits comfortably under (25 sets total).
    expect(totalPeakSets(day)).toBeLessThanOrEqual(30);
  });

  it('chest: wk1 / wk2 / wk3 / wk4 muscle-total = 7 / 8 / 9 / 6', () => {
    const day = build('push');
    const chest = slotsFor(day, 'chest')!;
    const sum = (wk: BlockWeek) => chest.reduce((a, s) => a + s.setsByWeek[wk], 0);
    expect(sum(1)).toBe(7);
    expect(sum(2)).toBe(8);
    expect(sum(3)).toBe(9);
    expect(sum(4)).toBe(6);
  });

  it('triceps: wk1 / wk2 / wk3 / wk4 muscle-total = 5 / 6 / 7 / 5', () => {
    const day = build('push');
    const tri = slotsFor(day, 'triceps')!;
    const sum = (wk: BlockWeek) => tri.reduce((a, s) => a + s.setsByWeek[wk], 0);
    // Peak 7 (weekly 14 / freq 2). Muscle ramp: 5 / 6 / 7 / deload(7)=5.
    expect(sum(1)).toBe(5);
    expect(sum(2)).toBe(6);
    expect(sum(3)).toBe(7);
    // deloadSets(7) = ceil(7 * 0.6) = 5
    expect(sum(4)).toBe(5);
  });
});

describe('CASE B — intermediate muscle · bro-split 5-day (freq = 1)', () => {
  const build = (dayType: string) => buildDayStructure({
    goal: 'muscle', dayType, location: 'gym', level: 'intermediate',
    split: 'bro_split', trainingDays: 5,
  })!;

  it('chest day: chest capped to 10 at wk3; ramp 8 / 9 / 10 / 6', () => {
    const day = build('chest');
    const chest = slotsFor(day, 'chest')!;
    const sum = (wk: BlockWeek) => chest.reduce((a, s) => a + s.setsByWeek[wk], 0);
    expect(sum(1)).toBe(8);
    expect(sum(2)).toBe(9);
    expect(sum(3)).toBe(10);
    expect(sum(4)).toBe(6);
  });

  it('arms day: biceps 6/7/8/5 and triceps 6/7/8/5 (both small caps at 8)', () => {
    const day = build('arms');
    const bi = slotsFor(day, 'biceps')!;
    const tri = slotsFor(day, 'triceps')!;
    const sum = (arr: typeof bi, wk: BlockWeek) => arr.reduce((a, s) => a + s.setsByWeek[wk], 0);
    expect(sum(bi, 1)).toBe(6);
    expect(sum(bi, 2)).toBe(7);
    expect(sum(bi, 3)).toBe(8);
    expect(sum(bi, 4)).toBe(5);
    expect(sum(tri, 1)).toBe(6);
    expect(sum(tri, 2)).toBe(7);
    expect(sum(tri, 3)).toBe(8);
    expect(sum(tri, 4)).toBe(5);
  });

  it('deload distributes ACROSS slots — never zeroes one out', () => {
    // The must-fix third item: deloadSets applied to a per-muscle session
    // total (e.g. 10 → 6) has to divide reasonably across the exercises,
    // not concentrate the cut on one slot.
    const day = build('chest');
    const chest = slotsFor(day, 'chest')!;
    // Every slot in wk4 has a non-trivial set count.
    for (const slot of chest) {
      expect(slot.setsByWeek[4]).toBeGreaterThanOrEqual(2);
    }
    // Ratio between max and min slot in wk4 stays sensible (≤ 2x).
    const wk4s = chest.map(s => s.setsByWeek[4]);
    expect(Math.max(...wk4s) / Math.min(...wk4s)).toBeLessThanOrEqual(2);
  });
});

describe('CASE C — advanced muscle · bro-split 5-day (freq = 1, worst-case junk-volume risk)', () => {
  const day = buildDayStructure({
    goal: 'muscle', dayType: 'chest', location: 'gym', level: 'advanced',
    split: 'bro_split', trainingDays: 5,
  })!;

  it('chest capped hard: session peak = 10 (down from weekly 18)', () => {
    const chest = slotsFor(day, 'chest')!;
    const peak = chest.reduce((a, s) => a + s.setsByWeek[3], 0);
    expect(peak).toBe(10);
  });

  it('ramp 8 / 9 / 10 / 6 — identical shape to Case B chest (cap floors both)', () => {
    const chest = slotsFor(day, 'chest')!;
    const sum = (wk: BlockWeek) => chest.reduce((a, s) => a + s.setsByWeek[wk], 0);
    expect(sum(1)).toBe(8);
    expect(sum(2)).toBe(9);
    expect(sum(3)).toBe(10);
    expect(sum(4)).toBe(6);
  });

  it('nothing exceeds MRV: whole-session peak ≤ session cap 25', () => {
    expect(totalPeakSets(day)).toBeLessThanOrEqual(25);
  });
});

describe('CASE D — intermediate strength · PPL 3-day (freq = 1)', () => {
  // The whole-session cap FIRES here — 3 majors × 3 slots + triceps × 2 = 8
  // movements @ 28 sets, over caps 6 / 20. The trim protects compound
  // anchors and primary slots (chest primary survives untouched), then
  // drops non-primary iso slots and trims non-primary iso sets from the
  // LAST muscle first. Chest is the day's primary focus and stays intact;
  // shoulders loses its iso; triceps loses one iso slot AND has its
  // remaining slot cut back.
  const build = (dayType: string) => buildDayStructure({
    goal: 'strength', dayType, location: 'gym', level: 'intermediate',
    split: 'ppl', trainingDays: 3,
  })!;

  it('chest survives the trim untouched: flat 10 sets/wk across weeks 1–3', () => {
    // Chest is FIRST in DAY_TYPE_MUSCLES for 'push' (highest priority) —
    // the trim walks from LAST muscle backward, so chest is only touched
    // as a last resort. On this fixture chest holds at 10 sets across
    // 3 slots (2 compound + 1 iso, all preserved).
    const day = build('push');
    const chest = slotsFor(day, 'chest')!;
    const sum = (wk: BlockWeek) => chest.reduce((a, s) => a + s.setsByWeek[wk], 0);
    expect(sum(1)).toBe(10);
    expect(sum(2)).toBe(10);
    expect(sum(3)).toBe(10);
    // deloadSets(10) = 6
    expect(sum(4)).toBe(6);
  });

  it('shoulders loses its non-primary iso slot in the movement-cap trim (10 → 7 sets)', () => {
    // Shoulders slot 2 is non-primary iso. The trim drops it to bring
    // movement count 8 → 6. Compound anchors (primary + secondary)
    // remain, so shoulders holds at 7 sets in 2 slots.
    const day = build('push');
    const shoulders = slotsFor(day, 'shoulders')!;
    expect(shoulders.length).toBe(2);
    expect(shoulders.every(s => s.compoundHint === 'compound')).toBe(true);
    const sum = (wk: BlockWeek) => shoulders.reduce((a, s) => a + s.setsByWeek[wk], 0);
    expect(sum(3)).toBe(7);
  });

  it('triceps takes the brunt: 8 sets → 3 sets, one iso slot dropped AND remaining slot trimmed', () => {
    // Triceps is LAST in DAY_TYPE_MUSCLES ordering, so the trim hits it
    // first. It loses one iso slot (8 → 4 sets) in the movement trim,
    // then loses another set (4 → 3) in the set trim to hit cap 20 total.
    // Small-muscle iso only — no primary anchor to protect here.
    const day = build('push');
    const tri = slotsFor(day, 'triceps')!;
    expect(tri.length).toBe(1);
    const sum = (wk: BlockWeek) => tri.reduce((a, s) => a + s.setsByWeek[wk], 0);
    expect(sum(3)).toBe(3);
    // deloadSets(3) = 2
    expect(sum(4)).toBe(2);
  });

  it('post-trim the push day totals ≤ 20 sets across ≤ 6 movements (strength lane caps)', () => {
    // The load-bearing assertion: the trim actually ran and put the
    // session within the strength-lane caps. If either check fails,
    // the trim is dormant on a realistic case — regression.
    const day = build('push');
    let totalSlots = 0;
    for (const m of day.muscles) totalSlots += m.slots.length;
    expect(totalSlots).toBeLessThanOrEqual(6);
    expect(totalPeakSets(day)).toBeLessThanOrEqual(20);
  });

  it('trim protects EVERY primary compound anchor across the day', () => {
    // Regression guard for the "primary slot never dropped" invariant.
    // Every muscle that has an isPrimarySlot in its structure must still
    // have that slot after the trim, at its full peak sets.
    const day = build('push');
    for (const m of day.muscles) {
      const primary = m.slots.find(s => s.isPrimarySlot);
      // Majors always have a primary; small muscles (triceps) don't.
      if (muscleTier(m.muscle) === 'major') {
        expect(primary).toBeDefined();
        // Primary anchor sets are 4 for strength lane (never trimmed).
        expect(primary!.setsByWeek[3]).toBe(4);
      }
    }
  });
});

// ── Compound stays flat; ramp lives on isolation ─────────────────────────

describe('ramp shape: isolation slots ramp, compound anchors hold flat', () => {
  it('muscle lane: compound slots have the same sets in wk1 as in wk3', () => {
    // Case A push chest — 2 compound + 1 isolation slots. Compounds should
    // hold flat across the ramp; the isolation slot absorbs the -2 delta.
    const day = buildDayStructure({
      goal: 'muscle', dayType: 'push', location: 'gym', level: 'advanced',
      split: 'ppl', trainingDays: 6,
    })!;
    const chest = slotsFor(day, 'chest')!;
    const compounds = chest.filter(s => s.compoundHint === 'compound');
    expect(compounds.length).toBeGreaterThan(0);
    for (const c of compounds) {
      // Compound wk1 sets must equal wk3 sets — the whole "don't pile sets
      // onto heavy compounds" invariant.
      expect(c.setsByWeek[1]).toBe(c.setsByWeek[3]);
      expect(c.setsByWeek[2]).toBe(c.setsByWeek[3]);
    }
  });

  it('major muscles always get at least one compound slot (ensureCompound invariant)', () => {
    for (const goal of ['strength', 'muscle'] as const) {
      const day = buildDayStructure({
        goal, dayType: 'push', location: 'gym', level: 'intermediate',
        split: 'ppl', trainingDays: 3,
      })!;
      for (const m of day.muscles) {
        if (muscleTier(m.muscle) === 'major') {
          const hasCompound = m.slots.some(s => s.compoundHint === 'compound');
          expect(hasCompound).toBe(true);
        }
      }
    }
  });

  it('small muscles are isolation-only in the slot structure', () => {
    // The picker may still find a compound for triceps (close-grip bench)
    // or biceps (chin-up), but the SLOT HINT is isolation on both lanes.
    const day = buildDayStructure({
      goal: 'muscle', dayType: 'arms', location: 'gym', level: 'intermediate',
      split: 'bro_split', trainingDays: 5,
    })!;
    for (const m of day.muscles) {
      if (muscleTier(m.muscle) === 'small') {
        expect(m.slots.every(s => s.compoundHint === 'isolation')).toBe(true);
      }
    }
  });
});

// ── Determinism substrate ────────────────────────────────────────────────

describe('determinism: slot IDENTITY is fixed across weeks 1–3 of a block', () => {
  it('slot COUNT and compound/isolation SEQUENCE are identical across all four weeks', () => {
    // The engine returns the same slot structure for wk1..wk4; only
    // setsByWeek varies. This is what preserves the mesocycle contract
    // downstream (same picker call ⇒ same exercises weeks 1–3).
    const day = buildDayStructure({
      goal: 'muscle', dayType: 'push', location: 'gym', level: 'advanced',
      split: 'ppl', trainingDays: 6,
    })!;
    const chest = slotsFor(day, 'chest')!;
    // The array itself is the "identity" — every property except
    // setsByWeek should be stable. Nothing about slot 0 (compound) turning
    // into an isolation slot mid-block, etc.
    for (const slot of chest) {
      expect(typeof slot.setsByWeek[1]).toBe('number');
      expect(typeof slot.setsByWeek[2]).toBe('number');
      expect(typeof slot.setsByWeek[3]).toBe('number');
      expect(typeof slot.setsByWeek[4]).toBe('number');
    }
    // The compound slots come FIRST in the array — that's what the picker
    // relies on for compound-first ordering.
    const kinds = chest.map(s => s.compoundHint);
    const firstIso = kinds.indexOf('isolation');
    if (firstIso >= 0) {
      // No compound slot comes AFTER any isolation slot.
      for (let i = firstIso + 1; i < kinds.length; i++) {
        expect(kinds[i]).toBe('isolation');
      }
    }
  });

  it('two calls with identical args return identical structures (pure)', () => {
    const args = {
      goal: 'muscle' as const,
      dayType: 'push',
      location: 'gym' as const,
      level: 'intermediate' as const,
      split: 'ppl' as const,
      trainingDays: 6,
    };
    expect(buildDayStructure(args)).toEqual(buildDayStructure(args));
  });
});

// ── Coverage / edge cases ────────────────────────────────────────────────

describe('coverage — engine-supported day types', () => {
  it('every dayType listed in each split has a muscle map', () => {
    // If this ever fails, generatePlan will silently fall through to
    // SPLIT_RULES for a lane that was supposed to be routed through the
    // engine.
    expect(isEngineSupportedDayType('full_body', 'full_body')).toBe(true);
    expect(isEngineSupportedDayType('upper_lower', 'upper')).toBe(true);
    expect(isEngineSupportedDayType('upper_lower', 'lower')).toBe(true);
    expect(isEngineSupportedDayType('ppl', 'push')).toBe(true);
    expect(isEngineSupportedDayType('ppl', 'pull')).toBe(true);
    expect(isEngineSupportedDayType('ppl', 'legs')).toBe(true);
    expect(isEngineSupportedDayType('bro_split', 'chest')).toBe(true);
    expect(isEngineSupportedDayType('bro_split', 'back')).toBe(true);
    expect(isEngineSupportedDayType('bro_split', 'shoulders')).toBe(true);
    expect(isEngineSupportedDayType('bro_split', 'arms')).toBe(true);
    expect(isEngineSupportedDayType('bro_split', 'legs')).toBe(true);
  });

  it('unknown dayType returns null structure (caller falls through)', () => {
    expect(buildDayStructure({
      goal: 'muscle', dayType: 'core', location: 'gym',
      level: 'intermediate', split: 'ppl', trainingDays: 3,
    })).toBeNull();
  });
});

// ── Exposed tables ───────────────────────────────────────────────────────

describe('PLAN_RULES_TABLES export', () => {
  it('exposes the four approved tables for downstream introspection', () => {
    expect(PLAN_RULES_TABLES.WEEKLY_PEAK_SETS.muscle.advanced.major).toBe(18);
    expect(PLAN_RULES_TABLES.PER_MUSCLE_SESSION_CAP.major).toBe(10);
    expect(PLAN_RULES_TABLES.PER_MUSCLE_SESSION_CAP.small).toBe(8);
    // Whole-session caps at the originally-approved values. Strength is
    // TIGHTER than muscle (long rest, fewer sets fit in a session); the
    // trim path is load-bearing and DOES fire on Case D strength push.
    expect(PLAN_RULES_TABLES.WHOLE_SESSION_CAP.strength).toBe(20);
    expect(PLAN_RULES_TABLES.WHOLE_SESSION_CAP.muscle).toBe(25);
    expect(PLAN_RULES_TABLES.COMPOUND_RATIO.strength).toBe(0.8);
    expect(PLAN_RULES_TABLES.COMPOUND_RATIO.muscle).toBe(0.5);
  });
});
