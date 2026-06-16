import { applyEnergyEffect, buildPrescriptionCoachLine, buildReadinessNarration, coachLineForPrescription, type CoachLineContext } from './coachHints';

// Minimal exercise shape that satisfies the generic constraint of
// applyEnergyEffect: { name; sets; equipment?; reps? }.
type Ex = { name: string; sets: number; equipment?: string; reps?: string | number };

// Fixture: a realistic 4-exercise session. Leading two are compounds, then
// an isolation, then a trailing isolation (so energy 1 has something to drop).
const session = (): Ex[] => [
  { name: 'Barbell Bench Press', sets: 4, equipment: 'barbell',  reps: '6-8'  },
  { name: 'Overhead Press',      sets: 3, equipment: 'barbell',  reps: '8-12' },
  { name: 'Cable Fly',           sets: 3, equipment: 'cable',    reps: '12-15' },
  { name: 'Tricep Pushdown',     sets: 3, equipment: 'cable',    reps: '10-15' },
];

// ── Energy 3: identity ─────────────────────────────────────────────────
describe('applyEnergyEffect — energy 3 (baseline)', () => {
  it('returns exercises unchanged in count, sets, and reps', () => {
    const input = session();
    const r = applyEnergyEffect(input, 3);
    expect(r.exercises).toHaveLength(input.length);
    r.exercises.forEach((ex, i) => {
      expect(ex.name).toBe(input[i].name);
      expect(ex.sets).toBe(input[i].sets);
      expect(ex.reps).toBe(input[i].reps);
    });
    expect(r.setsCut).toBe(0);
    expect(r.exerciseDropped).toBeNull();
    expect(r.setsAdded).toBe(0);
    expect(r.repBump).toBe(0);
  });
});

// ── Energy 5: leading two get +1 set, capped at 2 total ────────────────
describe('applyEnergyEffect — energy 5 (sharp upside)', () => {
  it('adds a set to the first two exercises, leaves the rest, total cap = 2', () => {
    const input = session(); // 4 exercises
    const r = applyEnergyEffect(input, 5);

    expect(r.setsAdded).toBe(2);
    expect(r.exercises).toHaveLength(input.length); // nothing dropped
    expect(r.exercises[0].sets).toBe(input[0].sets + 1);
    expect(r.exercises[1].sets).toBe(input[1].sets + 1);
    // Tail unchanged
    expect(r.exercises[2].sets).toBe(input[2].sets);
    expect(r.exercises[3].sets).toBe(input[3].sets);

    expect(r.setsCut).toBe(0);
    expect(r.exerciseDropped).toBeNull();
    expect(r.repBump).toBe(0);
  });

  it('caps setsAdded at 2 even when the session has many exercises', () => {
    const input: Ex[] = [
      { name: 'Squat',        sets: 4, equipment: 'barbell',  reps: '5-8' },
      { name: 'Bench Press',  sets: 4, equipment: 'barbell',  reps: '6-8' },
      { name: 'Row',          sets: 3, equipment: 'barbell',  reps: '8-10' },
      { name: 'Pull-up',      sets: 3, equipment: 'bodyweight', reps: '6-10' },
      { name: 'Lateral Raise',sets: 3, equipment: 'dumbbell', reps: '12-15' },
      { name: 'Bicep Curl',   sets: 3, equipment: 'dumbbell', reps: '10-12' },
    ];
    const r = applyEnergyEffect(input, 5);
    expect(r.setsAdded).toBe(2);
    // Only indices 0 and 1 should have gained a set.
    for (let i = 0; i < input.length; i++) {
      const expected = i < 2 ? input[i].sets + 1 : input[i].sets;
      expect(r.exercises[i].sets).toBe(expected);
    }
  });

  it('on a 1-exercise session, setsAdded is 1', () => {
    const input: Ex[] = [{ name: 'Squat', sets: 5, equipment: 'barbell', reps: 5 }];
    const r = applyEnergyEffect(input, 5);
    expect(r.setsAdded).toBe(1);
    expect(r.exercises[0].sets).toBe(6);
  });

  it('on an empty session, setsAdded is 0', () => {
    const r = applyEnergyEffect<Ex>([], 5);
    expect(r.setsAdded).toBe(0);
    expect(r.exercises).toHaveLength(0);
  });
});

// ── Energy 4: reps bumped, sets untouched ──────────────────────────────
describe('applyEnergyEffect — energy 4 (rep bump)', () => {
  it('bumps the rep range and adds no sets', () => {
    const input = session();
    const r = applyEnergyEffect(input, 4);

    expect(r.repBump).toBe(2);
    expect(r.setsAdded).toBe(0);
    expect(r.setsCut).toBe(0);
    expect(r.exerciseDropped).toBeNull();

    // Sets are unchanged everywhere.
    r.exercises.forEach((ex, i) => {
      expect(ex.sets).toBe(input[i].sets);
    });

    // Reps are bumped on each: "6-8" → "8-10", "8-12" → "10-14",
    // "12-15" → "14-17", "10-15" → "12-17".
    expect(r.exercises[0].reps).toBe('8-10');
    expect(r.exercises[1].reps).toBe('10-14');
    expect(r.exercises[2].reps).toBe('14-17');
    expect(r.exercises[3].reps).toBe('12-17');
  });

  it('bumps a single-number string rep ("10" → "12")', () => {
    const input: Ex[] = [{ name: 'Squat', sets: 5, reps: '10' }];
    const r = applyEnergyEffect(input, 4);
    expect(r.exercises[0].reps).toBe('12');
  });

  it('bumps a numeric rep (10 → 12, returned as number)', () => {
    const input: Ex[] = [{ name: 'Squat', sets: 5, reps: 10 }];
    const r = applyEnergyEffect(input, 4);
    expect(r.exercises[0].reps).toBe(12);
    expect(typeof r.exercises[0].reps).toBe('number');
  });

  it('leaves non-numeric reps untouched and does not crash', () => {
    const input: Ex[] = [
      { name: 'Pull-up', sets: 3, equipment: 'bodyweight', reps: 'AMRAP' },
      { name: 'Plank',   sets: 3, equipment: 'bodyweight', reps: 'to failure' },
      { name: 'Burpee',  sets: 3, equipment: 'bodyweight' /* reps undefined */ },
    ];
    const r = applyEnergyEffect(input, 4);
    expect(r.exercises[0].reps).toBe('AMRAP');
    expect(r.exercises[1].reps).toBe('to failure');
    expect(r.exercises[2].reps).toBeUndefined();
    // Sets and other shape preserved.
    expect(r.exercises).toHaveLength(3);
  });
});

// ── Energy 1 and 2: existing low-energy reduction ──────────────────────
describe('applyEnergyEffect — energy 1 and 2 (low energy)', () => {
  it('energy 2 cuts a set off every exercise (none dropped)', () => {
    const input = session();
    const r = applyEnergyEffect(input, 2);

    // All 4 exercises have sets > 1 in the fixture, so all 4 lose one.
    expect(r.exercises).toHaveLength(input.length);
    expect(r.exerciseDropped).toBeNull();
    expect(r.setsCut).toBe(input.length);
    r.exercises.forEach((ex, i) => {
      expect(ex.sets).toBe(input[i].sets - 1);
    });
    expect(r.setsAdded).toBe(0);
    expect(r.repBump).toBe(0);
  });

  it('energy 1 drops the trailing isolation AND cuts a set off the remainder', () => {
    const input = session();
    const r = applyEnergyEffect(input, 1);

    // "Tricep Pushdown" matches the isolation keyword ' pushdown' and is the
    // trailing non-bodyweight isolation, so it should be dropped.
    expect(r.exerciseDropped).toBe('Tricep Pushdown');
    expect(r.exercises).toHaveLength(input.length - 1);
    expect(r.exercises.find(e => e.name === 'Tricep Pushdown')).toBeUndefined();

    // Remaining 3 each lose one set.
    expect(r.setsCut).toBe(input.length - 1);
    expect(r.setsAdded).toBe(0);
    expect(r.repBump).toBe(0);
  });

  it('energy 1 floors sets at 1 — exercises already at 1 set are not cut further', () => {
    const input: Ex[] = [
      { name: 'Squat',        sets: 1, equipment: 'barbell', reps: '5' },
      { name: 'Bench Press',  sets: 2, equipment: 'barbell', reps: '5' },
    ];
    const r = applyEnergyEffect(input, 1);
    // Neither is an isolation, so nothing is dropped.
    expect(r.exerciseDropped).toBeNull();
    expect(r.exercises).toHaveLength(2);
    // The 1-set exercise stays at 1; the 2-set drops to 1.
    expect(r.exercises[0].sets).toBe(1);
    expect(r.exercises[1].sets).toBe(1);
    expect(r.setsCut).toBe(1); // only one exercise was actually trimmable
  });
});

// ── buildPrescriptionCoachLine ─────────────────────────────────────────
// Every prescription rationale must produce a specific, intentional line —
// the regression we're guarding against is the old fall-through to a
// generic form cue on no_history/hold, which made the coach feel absent.

// ── buildPrescriptionCoachLine — energy × rationale matrix ────────────
// The copy branches on (rationale × energy band). Every numeric branch
// must embed both lastWeightKg (where applicable) and suggestedWeightKg
// (where they differ) so the user reads the line in terms of what they
// actually lifted last time.

describe('buildPrescriptionCoachLine — no_history', () => {
  const base: CoachLineContext = {
    rationale: 'no_history',
    suggestedWeightKg: 0,
    lastWeightKg: 0,
    deltaPct: 0,
    energyScore: 3,
  };

  it('no_history + normal energy → calibration line (about 1 left in the tank)', () => {
    const line = buildPrescriptionCoachLine({ ...base });
    expect(line).toMatch(/First time on this/);
    expect(line).toMatch(/calibrate/);
    expect(line).not.toMatch(/\d+\s?kg/);
  });

  it('no_history + low energy → same calibration line (no high-energy override)', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 1 });
    expect(line).toMatch(/First time on this/);
    expect(line).toMatch(/calibrate/);
  });

  it('no_history + high energy → "good energy, pick something challenging" variant', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 5 });
    expect(line).toMatch(/good energy/i);
    expect(line).toMatch(/challenging/);
    expect(line).toMatch(/I'll learn/);
  });
});

describe('buildPrescriptionCoachLine — hold (suggested == last)', () => {
  const base: CoachLineContext = {
    rationale: 'hold',
    suggestedWeightKg: 80,
    lastWeightKg: 80,
    deltaPct: 0,
    energyScore: 3,
  };

  it('low energy → references last weight + "no grinding"', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 2 });
    expect(line).toMatch(/Last time was 80 kg/);
    expect(line).toMatch(/no grinding/);
  });

  it('normal energy → references last weight + "own every rep"', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 3 });
    expect(line).toMatch(/You did 80 kg last time/);
    expect(line).toMatch(/own every rep/);
  });

  it('high energy → "energy\'s good" + "chase an extra rep" + last weight', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 5 });
    expect(line).toMatch(/Energy's good today/);
    expect(line).toMatch(/80 kg/);
    expect(line).toMatch(/extra rep/);
  });
});

describe('buildPrescriptionCoachLine — progress (suggested > last)', () => {
  const base: CoachLineContext = {
    rationale: 'progress',
    suggestedWeightKg: 82.5,
    lastWeightKg: 80,
    deltaPct: 0.0313,
    energyScore: 3,
  };

  it('normal energy → embeds BOTH last (80) and suggested (82.5) kg', () => {
    const line = buildPrescriptionCoachLine({ ...base });
    expect(line).toMatch(/80 kg/);
    expect(line).toMatch(/82\.5 kg/);
    expect(line).toMatch(/step up/i);
  });

  it('low energy → conditional "only go {suggested} kg if it moves clean"', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 2 });
    expect(line).toMatch(/low today/);
    expect(line).toMatch(/82\.5 kg/);
    expect(line).toMatch(/moves clean/);
  });

  it('high energy → "go get {suggested} kg today, up from {last}"', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 4 });
    expect(line).toMatch(/Good energy/);
    expect(line).toMatch(/82\.5 kg/);
    expect(line).toMatch(/up from 80/);
  });

  it('kg formatting trims trailing .0 (40 → "40", not "40.0")', () => {
    const line = buildPrescriptionCoachLine({
      ...base,
      suggestedWeightKg: 40,
      lastWeightKg: 37.5,
    });
    expect(line).toMatch(/40 kg/);
    expect(line).not.toMatch(/40\.0/);
    expect(line).toMatch(/37\.5/);
  });

  // ── Equal-display-weight guard ────────────────────────────────────
  // The load engine can prescribe a sub-display-resolution bump (e.g.
  // 80 → 80.4) that rounds to the same kg(). The raw "up from X" copy
  // would then read "20 kg, up from 20" — contradictory. The progress
  // branch must fall back to hold phrasing in that case.

  it('suggested === last under progress: no "up from" wording, no "step up to" wording', () => {
    // 20 and 20.04 both round to "20" via kg() (1-decimal rounding).
    const line = buildPrescriptionCoachLine({
      ...base,
      rationale: 'progress',
      suggestedWeightKg: 20.04,
      lastWeightKg: 20,
      energyScore: 3,
    });
    expect(line).not.toMatch(/up from/i);
    expect(line).not.toMatch(/step up to/i);
    // Falls back to the hold-style "did 20 kg last time / own every rep" copy.
    expect(line).toMatch(/20 kg/);
    expect(line).toMatch(/last time/i);
  });

  it('suggested === last under progress, low energy: falls back to hold-low copy', () => {
    const line = buildPrescriptionCoachLine({
      ...base,
      rationale: 'progress',
      suggestedWeightKg: 80,
      lastWeightKg: 80,
      energyScore: 1,
    });
    expect(line).not.toMatch(/up from/i);
    expect(line).toMatch(/80 kg/);
    expect(line).toMatch(/no grinding/i);
  });

  it('suggested === last under progress, high energy: falls back to hold-high copy', () => {
    const line = buildPrescriptionCoachLine({
      ...base,
      rationale: 'progress',
      suggestedWeightKg: 100,
      lastWeightKg: 100,
      energyScore: 5,
    });
    expect(line).not.toMatch(/up from/i);
    expect(line).toMatch(/100 kg/);
    expect(line).toMatch(/extra rep/i);
  });
});

describe('buildPrescriptionCoachLine — backoff (suggested < last)', () => {
  const base: CoachLineContext = {
    rationale: 'backoff',
    suggestedWeightKg: 76,
    lastWeightKg: 80,
    deltaPct: -0.05,
    energyScore: 3,
  };

  it('normal energy → "drop to {suggested} kg and nail every rep"', () => {
    const line = buildPrescriptionCoachLine({ ...base });
    expect(line).toMatch(/hit the wall/);
    expect(line).toMatch(/76 kg/);
    expect(line).toMatch(/nail every rep/);
  });

  it('low energy → "back off to {suggested} kg and rebuild"', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 1 });
    expect(line).toMatch(/drained today/);
    expect(line).toMatch(/back off to 76 kg/);
    expect(line).toMatch(/rebuild/);
  });

  it('high energy → "Reset today: {suggested} kg, sharp and clean"', () => {
    const line = buildPrescriptionCoachLine({ ...base, energyScore: 5 });
    expect(line).toMatch(/Reset today/);
    expect(line).toMatch(/76 kg/);
    expect(line).toMatch(/sharp and clean/);
  });

  // ── Equal-display-weight guard on the backoff branch ──────────────
  // A −5% bump on a 22.5 kg dumbbell rounds back to the same plate.
  // The line must NOT claim a reduction in that case.

  it('suggested === last under backoff: no "back off"/"rebuild"/"hit the wall" wording', () => {
    // 22.5 × 0.95 = 21.375 → roundToPlate ≈ 22.5 (same plate).
    const line = buildPrescriptionCoachLine({
      ...base,
      rationale: 'backoff',
      suggestedWeightKg: 22.5,
      lastWeightKg: 22.5,
      energyScore: 3,
    });
    expect(line).not.toMatch(/back off/i);
    expect(line).not.toMatch(/rebuild/i);
    expect(line).not.toMatch(/hit the wall/i);
    // Falls back to hold-normal copy.
    expect(line).toMatch(/22\.5 kg/);
    expect(line).toMatch(/last time/i);
  });

  it('suggested === last under backoff, low energy: falls back to hold-low copy', () => {
    const line = buildPrescriptionCoachLine({
      ...base,
      rationale: 'backoff',
      suggestedWeightKg: 80,
      lastWeightKg: 80,
      energyScore: 1,
    });
    expect(line).not.toMatch(/back off to 80/i);
    expect(line).not.toMatch(/hit the wall/i);
    expect(line).toMatch(/80 kg/);
    expect(line).toMatch(/energy/i);
  });
});

// ── cause: 'low_energy' vs 'failure' ──────────────────────────────────
// The low-energy down-modifier in prescribeLoad converts a hold into a
// backoff even when last session was fine. Without the cause field,
// the coach told the user "tough one last time" — false. With the
// cause field, the backoff line frames it as an energy-protective
// move and never claims the last session was a grind.

describe('buildPrescriptionCoachLine — cause distinguishes failure vs low_energy backoff', () => {
  const baseBackoff: CoachLineContext = {
    rationale: 'backoff',
    suggestedWeightKg: 76,
    lastWeightKg: 80,
    deltaPct: -0.05,
    energyScore: 2,
  };

  it('cause=low_energy: energy-framed copy, NEVER "tough one last time" / "hit the wall"', () => {
    const line = buildPrescriptionCoachLine({ ...baseBackoff, cause: 'low_energy' });
    // Energy-framed.
    expect(line.toLowerCase()).toMatch(/energy|drained|easing|protect/);
    // Real numbers.
    expect(line).toMatch(/76 kg/);
    // Honesty: last session was fine, never claim otherwise.
    expect(line).not.toMatch(/tough one last time/i);
    expect(line).not.toMatch(/hit the wall/i);
    expect(line).not.toMatch(/rebuild/i);
  });

  it('cause=failure: failure-framed copy with the "tough/wall/grind" narrative is allowed', () => {
    const line = buildPrescriptionCoachLine({ ...baseBackoff, cause: 'failure' });
    expect(line).toMatch(/76 kg/);
    // Low-band failure pool variants reference one of these.
    expect(line.toLowerCase()).toMatch(/tough|wall|grind|rebuild|drained/);
    // Never the low-energy "easing" / "pulling the load down" framing.
    expect(line.toLowerCase()).not.toMatch(/easing back|pulling the load/);
  });

  it('default (cause omitted) preserves backward-compatible failure framing', () => {
    // Pre-cause callers should not see a behavior change at low band.
    const line = buildPrescriptionCoachLine({ ...baseBackoff });
    expect(line.toLowerCase()).toMatch(/tough|wall|grind|drained|rebuild/);
  });
});

// ── coachLineForPrescription — shared surface mapping ──────────────────
// The active weight popup used to hand-roll its own strings: a missing
// prescription (swapped-in lift) rendered nothing, and every backoff was
// blamed on failure regardless of cause. Both surfaces now route through
// this mapper — these tests pin the two regressions.

describe('coachLineForPrescription — prescription-or-absence mapping', () => {
  it('no prescription (swapped-in / history-less lift) → calibration line, not blank', () => {
    const line = coachLineForPrescription(undefined, {
      exerciseName: 'Cable Fly',
      energyScore: 3,
    });
    expect(line.length).toBeGreaterThan(0);
    // One of the no_history calibration variants, never a kg claim.
    expect(line.toLowerCase()).toMatch(/first time|fresh lift|new movement/);
    expect(line).not.toMatch(/\d+\s?kg/);
  });

  it('low-energy backoff → energy-framed line, never the failure narrative', () => {
    const line = coachLineForPrescription(
      { rationale: 'backoff', suggestedWeightKg: 76, deltaPct: -0.05, cause: 'low_energy' },
      { exerciseName: 'Bench Press', lastWeightKg: 80, energyScore: 2 }
    );
    expect(line).toMatch(/76 kg/);
    expect(line.toLowerCase()).toMatch(/energy|drained|easing|protect/);
    expect(line).not.toMatch(/hit the wall/i);
    expect(line).not.toMatch(/tough one last time/i);
    expect(line).not.toMatch(/you hit failure/i);
  });

  it('failure backoff keeps the failure framing', () => {
    const line = coachLineForPrescription(
      { rationale: 'backoff', suggestedWeightKg: 76, deltaPct: -0.05, cause: 'failure' },
      { exerciseName: 'Bench Press', lastWeightKg: 80, energyScore: 3 }
    );
    expect(line).toMatch(/76 kg/);
    expect(line.toLowerCase()).toMatch(/wall|grind|step back|step down/);
  });

  it('cold lastWeights falls back to the suggested weight so the kg slot stays non-empty', () => {
    const line = coachLineForPrescription(
      { rationale: 'hold', suggestedWeightKg: 60, deltaPct: 0, cause: 'rir' },
      { exerciseName: 'Seated Row', energyScore: 3 }
    );
    expect(line).toMatch(/60 kg/);
  });

  it('matches buildPrescriptionCoachLine output for the same context (shared voice)', () => {
    const viaMapper = coachLineForPrescription(
      { rationale: 'progress', suggestedWeightKg: 82.5, deltaPct: 0.05, cause: 'rir' },
      { exerciseName: 'Squat', lastWeightKg: 80, energyScore: 4, blockWeek: 3 }
    );
    const direct = buildPrescriptionCoachLine({
      rationale: 'progress',
      suggestedWeightKg: 82.5,
      lastWeightKg: 80,
      deltaPct: 0.05,
      energyScore: 4,
      blockWeek: 3,
      cause: 'rir',
      exerciseName: 'Squat',
    });
    expect(viaMapper).toBe(direct);
  });
});

// ── Per-exercise variety pools ─────────────────────────────────────────
// Two exercises in the SAME (rationale, band, cause) state must read
// differently when their names differ — deterministic per-name seed
// inside the pool. Without exerciseName the legacy pool[0] is returned.

describe('buildPrescriptionCoachLine — per-exercise variety', () => {
  const baseHold: CoachLineContext = {
    rationale: 'hold',
    suggestedWeightKg: 80,
    lastWeightKg: 80,
    deltaPct: 0,
    energyScore: 3,
  };

  it('different exerciseName → potentially different pool entry (variety in the same state)', () => {
    // Build a few exercise names; assert we see at least two distinct
    // outputs. Stable hash → with 3 pool entries and >= 8 names, the
    // distribution will hit at least two.
    const names = ['Bench Press', 'Overhead Press', 'Barbell Row', 'Lat Pulldown', 'Squat', 'Deadlift', 'Hamstring Curl', 'Leg Extension'];
    const out = new Set(names.map(n => buildPrescriptionCoachLine({ ...baseHold, exerciseName: n })));
    expect(out.size).toBeGreaterThan(1);
  });

  it('same exerciseName → SAME line every time (deterministic per-name pick)', () => {
    const a = buildPrescriptionCoachLine({ ...baseHold, exerciseName: 'Bench Press' });
    const b = buildPrescriptionCoachLine({ ...baseHold, exerciseName: 'Bench Press' });
    expect(a).toBe(b);
  });

  it('every variant is honest — any number it prints is the supplied weight, never a fabricated one', () => {
    // Non-load form-cue variants may omit the weight entirely (the coach
    // isn't always talking about load). The invariant that still holds: a
    // variant never invents a number the caller didn't supply. baseHold has
    // no blockWeek, so the only legal number is the supplied last weight (80).
    const names = ['Bench Press', 'Overhead Press', 'Barbell Row', 'Lat Pulldown', 'Squat', 'Deadlift', 'Hamstring Curl', 'Leg Extension', 'Hip Thrust', 'Front Squat'];
    for (const n of names) {
      const line = buildPrescriptionCoachLine({ ...baseHold, exerciseName: n });
      expect(line).not.toMatch(/undefined/);
      for (const num of line.match(/\d+(?:\.\d+)?/g) ?? []) {
        expect(num).toBe('80');
      }
    }
  });

  it('no exerciseName → backward-compatible pool[0] (legacy contract)', () => {
    const a = buildPrescriptionCoachLine({ ...baseHold });
    const b = buildPrescriptionCoachLine({ ...baseHold, exerciseName: undefined });
    expect(a).toBe(b);
  });
});

// ── Copy polish: lift-name + non-load (rep-quality/tempo/control) variants ──
// Two additions on top of the load lines: occasionally name the lift, and
// occasionally talk about execution instead of load. Both must stay honest
// (only supplied numbers) and only ever appear when a name was provided.

describe('buildPrescriptionCoachLine — lift-name + non-load variants', () => {
  const SWEEP = [
    'Bench Press', 'Overhead Press', 'Barbell Row', 'Lat Pulldown', 'Squat',
    'Deadlift', 'Hamstring Curl', 'Leg Extension', 'Hip Thrust', 'Front Squat',
    'Romanian Deadlift', 'Incline Bench', 'Seated Row', 'Face Pull', 'Hammer Curl',
    'Skullcrusher', 'Calf Raise', 'Good Morning', 'Pull-up', 'Chest Press',
  ];

  const progressHigh: CoachLineContext = {
    rationale: 'progress', suggestedWeightKg: 82.5, lastWeightKg: 80,
    deltaPct: 0.0313, energyScore: 4,
  };

  it('names the lift in SOME lines when a name is provided — occasional, not every line', () => {
    const rendered = SWEEP.map(n => ({ n, line: buildPrescriptionCoachLine({ ...progressHigh, exerciseName: n }) }));
    const named = rendered.filter(({ n, line }) => line.includes(n));
    expect(named.length).toBeGreaterThan(0);          // the named variant is reachable
    expect(named.length).toBeLessThan(SWEEP.length);  // ...but not every line (varied)
    // A named progress line still carries the real suggested weight — honest.
    for (const { line } of named) expect(line).toMatch(/82\.5 kg/);
  });

  it('non-load rep-quality / tempo / control cues render in the hold (match) bucket', () => {
    const baseHold: CoachLineContext = {
      rationale: 'hold', suggestedWeightKg: 80, lastWeightKg: 80, deltaPct: 0, energyScore: 3,
    };
    const joined = SWEEP.map(n => buildPrescriptionCoachLine({ ...baseHold, exerciseName: n })).join('\n').toLowerCase();
    // At least one swept name lands on a form-cue variant.
    expect(joined).toMatch(/own the eccentric|every rep look identical|control the way down|own the tempo/);
  });

  it('low-energy hold offers a control cue without a fabricated number', () => {
    const joined = SWEEP.map(n => buildPrescriptionCoachLine({
      rationale: 'hold', suggestedWeightKg: 80, lastWeightKg: 80, deltaPct: 0, energyScore: 2, exerciseName: n,
    })).join('\n').toLowerCase();
    expect(joined).toMatch(/control the way down|no bouncing/);
  });

  it('nothing throws and no "undefined" leaks when the exercise name is ABSENT', () => {
    const states: CoachLineContext[] = [
      { rationale: 'hold',     suggestedWeightKg: 80,   lastWeightKg: 80, deltaPct: 0,      energyScore: 1 },
      { rationale: 'hold',     suggestedWeightKg: 80,   lastWeightKg: 80, deltaPct: 0,      energyScore: 3 },
      { rationale: 'hold',     suggestedWeightKg: 80,   lastWeightKg: 80, deltaPct: 0,      energyScore: 5 },
      { rationale: 'progress', suggestedWeightKg: 82.5, lastWeightKg: 80, deltaPct: 0.03,   energyScore: 3 },
      { rationale: 'progress', suggestedWeightKg: 82.5, lastWeightKg: 80, deltaPct: 0.03,   energyScore: 5 },
      { rationale: 'backoff',  suggestedWeightKg: 76,   lastWeightKg: 80, deltaPct: -0.05,  energyScore: 3, cause: 'failure' },
    ];
    for (const c of states) {
      const line = buildPrescriptionCoachLine(c); // no exerciseName
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toMatch(/undefined/);
    }
  });

  it('new variants keep the tone guard (no emoji, no exclamation) across every name', () => {
    const emojiRe = /[☀-➿\u{1F300}-\u{1FAFF}]/u;
    const states: CoachLineContext[] = [
      { rationale: 'hold',     suggestedWeightKg: 80,   lastWeightKg: 80, deltaPct: 0,     energyScore: 3 },
      { rationale: 'hold',     suggestedWeightKg: 80,   lastWeightKg: 80, deltaPct: 0,     energyScore: 5 },
      { rationale: 'progress', suggestedWeightKg: 82.5, lastWeightKg: 80, deltaPct: 0.03,  energyScore: 5 },
      { rationale: 'progress', suggestedWeightKg: 82.5, lastWeightKg: 80, deltaPct: 0.03,  energyScore: 3 },
      { rationale: 'backoff',  suggestedWeightKg: 76,   lastWeightKg: 80, deltaPct: -0.05, energyScore: 3, cause: 'failure' },
    ];
    for (const base of states) {
      for (const n of SWEEP) {
        const line = buildPrescriptionCoachLine({ ...base, exerciseName: n });
        expect(line).not.toMatch(emojiRe);
        expect(line).not.toMatch(/!/);
      }
    }
  });
});

describe('buildPrescriptionCoachLine — block-week nudge', () => {
  const progress: CoachLineContext = {
    rationale: 'progress',
    suggestedWeightKg: 82.5,
    lastWeightKg: 80,
    deltaPct: 0.0313,
    energyScore: 3,
  };

  it('weeks 1 and 2 — no week-N suffix', () => {
    for (const w of [1, 2] as const) {
      const line = buildPrescriptionCoachLine({ ...progress, blockWeek: w });
      expect(line).not.toMatch(/Week \d on this lift/);
    }
  });

  it('week 3 — appends "Week 3 on this lift — chase one more rep…"', () => {
    const line = buildPrescriptionCoachLine({ ...progress, blockWeek: 3 });
    expect(line).toMatch(/Week 3 on this lift — chase one more rep than last time\./);
  });

  it('week 4 — appends "Week 4 …"', () => {
    const line = buildPrescriptionCoachLine({ ...progress, blockWeek: 4 });
    expect(line).toMatch(/Week 4 on this lift — chase one more rep than last time\./);
  });

  it('block nudge appends across rationales and energy bands (no_history, low-energy hold)', () => {
    const a = buildPrescriptionCoachLine({
      rationale: 'no_history', suggestedWeightKg: 0, lastWeightKg: 0,
      deltaPct: 0, energyScore: 3, blockWeek: 4,
    });
    expect(a).toMatch(/First time on this/);
    expect(a).toMatch(/Week 4 on this lift/);

    const b = buildPrescriptionCoachLine({
      rationale: 'hold', suggestedWeightKg: 80, lastWeightKg: 80,
      deltaPct: 0, energyScore: 2, blockWeek: 3,
    });
    expect(b).toMatch(/Last time was 80 kg/);
    expect(b).toMatch(/Week 3 on this lift/);
  });

  it('undefined blockWeek — no suffix', () => {
    const line = buildPrescriptionCoachLine({ ...progress, blockWeek: undefined });
    expect(line).not.toMatch(/Week/);
  });
});

describe('buildPrescriptionCoachLine — tone guards', () => {
  const cases: CoachLineContext[] = [];
  for (const rationale of ['no_history', 'hold', 'progress', 'backoff'] as const) {
    for (const energyScore of [1, 2, 3, 4, 5]) {
      cases.push({
        rationale,
        suggestedWeightKg: rationale === 'progress' ? 82.5 : rationale === 'backoff' ? 76 : 80,
        lastWeightKg: rationale === 'progress' ? 80 : rationale === 'backoff' ? 80 : rationale === 'hold' ? 80 : 0,
        deltaPct: rationale === 'progress' ? 0.0313 : rationale === 'backoff' ? -0.05 : 0,
        energyScore,
      });
    }
  }

  it('no line contains an emoji', () => {
    const emojiRe = /[☀-➿\u{1F300}-\u{1FAFF}]/u;
    for (const c of cases) {
      expect(buildPrescriptionCoachLine(c)).not.toMatch(emojiRe);
    }
  });

  it('no line contains an exclamation mark (no cheerleading)', () => {
    for (const c of cases) {
      expect(buildPrescriptionCoachLine(c)).not.toMatch(/!/);
    }
  });

  it('lines that name the prior load embed the lastWeightKg number', () => {
    // Per spec (info/exercise-ranking task #11), the copy names {last} as
    // a kg number on the bands listed below. Other bands intentionally
    // use phrases like "last time" without a number ({last} would be
    // redundant when paired with {suggested} in a "Reset today" or
    // "drop to {suggested}" framing).
    const NAMES_LAST_NUMBER = new Set([
      'hold|1', 'hold|2', 'hold|3', 'hold|4', 'hold|5',
      'progress|3', 'progress|4', 'progress|5',
    ]);
    for (const c of cases) {
      const key = `${c.rationale}|${c.energyScore}`;
      if (!NAMES_LAST_NUMBER.has(key)) continue;
      const line = buildPrescriptionCoachLine(c);
      const last = String(Math.round(c.lastWeightKg * 10) / 10).replace(/\.0$/, '');
      expect(line).toMatch(new RegExp(last.replace(/\./g, '\\.')));
    }
  });
});

// ── Determinism ────────────────────────────────────────────────────────
describe('applyEnergyEffect — determinism', () => {
  it('produces identical output for the same input across energy levels', () => {
    for (const energy of [1, 2, 3, 4, 5]) {
      const a = applyEnergyEffect(session(), energy);
      const b = applyEnergyEffect(session(), energy);
      expect(b).toEqual(a);
    }
  });
});

// ── buildReadinessNarration — session-level autoregulation ─────────────
// One branch per energy band so a future copy edit can't silently flip
// the contract. The "no nag at baseline" rule (energy=3 → null) is the
// load-bearing one — returning null is what stops a banner from showing
// for every single session.

describe('buildReadinessNarration', () => {
  it('energy <= 2 → conservative stance with the low-energy line', () => {
    for (const e of [1, 2]) {
      const r = buildReadinessNarration(e);
      expect(r).not.toBeNull();
      expect(r!.stance).toBe('conservative');
      expect(r!.text).toMatch(/Energy's low/);
      expect(r!.text).toMatch(/conservative/);
      expect(r!.text).toMatch(/protect recovery/);
    }
  });

  it('energy === 3 → null (no nag at baseline)', () => {
    expect(buildReadinessNarration(3)).toBeNull();
  });

  it('energy >= 4 → green stance with the green-light line', () => {
    for (const e of [4, 5]) {
      const r = buildReadinessNarration(e);
      expect(r).not.toBeNull();
      expect(r!.stance).toBe('green');
      expect(r!.text).toMatch(/green light/i);
      expect(r!.text).toMatch(/top sets/);
    }
  });

  it('does not claim it changed specific weights (honest copy)', () => {
    // The narration is about STANCE, not arithmetic. Per-lift weight
    // changes still happen at log-time via loadPrescription. The copy
    // must never imply the coach swapped specific kg numbers.
    for (const e of [1, 2, 4, 5]) {
      const r = buildReadinessNarration(e);
      if (!r) continue;
      expect(r.text).not.toMatch(/\d+\s?kg/i);
      expect(r.text).not.toMatch(/changed (your )?bench/i);
    }
  });

  it('defensive: non-finite input → null (no crash, no false narration)', () => {
    expect(buildReadinessNarration(NaN)).toBeNull();
    expect(buildReadinessNarration(Infinity)).toBeNull();
  });
});

