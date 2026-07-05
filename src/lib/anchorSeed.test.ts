import {
  ANCHOR_LIFTS,
  ANCHOR_SEED_DAYS_AGO,
  ANCHOR_SEED_RIR,
  buildAnchorSeedRows,
  estimateWorkingWeightKg,
  parseAnchorEntry,
  targetRepsFromRange,
} from './anchorSeed';
import { EXERCISES } from '../constants/exercises';

describe('parseAnchorEntry', () => {
  it('parses a valid weight × reps pair', () => {
    expect(parseAnchorEntry('100', '5')).toEqual({ weightKg: 100, reps: 5 });
  });

  it('accepts a comma decimal (EU input)', () => {
    expect(parseAnchorEntry('102,5', '5')).toEqual({ weightKg: 102.5, reps: 5 });
  });

  it('returns null when either field is blank — every anchor is independently optional', () => {
    expect(parseAnchorEntry('', '5')).toBeNull();
    expect(parseAnchorEntry('100', '')).toBeNull();
    expect(parseAnchorEntry('', '')).toBeNull();
  });

  it('returns null for unparseable input rather than throwing', () => {
    expect(parseAnchorEntry('abc', '5')).toBeNull();
    expect(parseAnchorEntry('100', 'abc')).toBeNull();
  });

  it('rejects out-of-range weight (fat-finger guard)', () => {
    expect(parseAnchorEntry('1', '5')).toBeNull(); // below MIN
    expect(parseAnchorEntry('9999', '5')).toBeNull(); // above MAX
  });

  it('rejects non-integer or out-of-range reps', () => {
    expect(parseAnchorEntry('100', '5.5')).toBeNull();
    expect(parseAnchorEntry('100', '0')).toBeNull();
    expect(parseAnchorEntry('100', '25')).toBeNull(); // above MAX (20) — Epley drifts past this
  });
});

describe('targetRepsFromRange', () => {
  it('parses a "lo-hi" range to its rounded midpoint', () => {
    expect(targetRepsFromRange('8-12')).toBe(10);
    expect(targetRepsFromRange('5-8')).toBe(7); // 6.5 rounds up
    expect(targetRepsFromRange('12-15')).toBe(14); // 13.5 rounds up
  });

  it('falls back to 10 for missing/malformed input rather than throwing', () => {
    expect(targetRepsFromRange(null)).toBe(10);
    expect(targetRepsFromRange(undefined)).toBe(10);
    expect(targetRepsFromRange('')).toBe(10);
    expect(targetRepsFromRange('garbage')).toBe(10);
  });

  it('parses a single-number range', () => {
    expect(targetRepsFromRange('12')).toBe(12);
  });
});

// ── estimateWorkingWeightKg — the credibility-critical conversion ──────
// Part D of the anchor-seed feature: a near-max anchor entry (e.g. a
// ~5-rep max) must NOT be echoed straight into a higher-rep prescription.
// These pin the exact worked examples used in the PR report.

describe('estimateWorkingWeightKg', () => {
  it('WORKED EXAMPLE: 100kg x 5 → ~82.5kg for a 10-rep target (Bench, 8-12 range) at RIR 2', () => {
    // e1RM = 100 * (1 + 5/30) = 116.67
    // effective failure reps = 10 + 2 = 12
    // raw = 116.67 / (1 + 12/30) = 116.67 / 1.4 = 83.33 → rounds to 82.5
    const kg = estimateWorkingWeightKg(100, 5, 10, 2);
    expect(kg).toBe(82.5);
  });

  it('the seeded weight is a plausible fraction of the entered near-max, not an echo of it', () => {
    // Credibility check: the seeded number must sit well below the raw
    // entered weight (it's a higher-rep working set, not a 5RM), and
    // comfortably above zero. This is the bug the whole module exists to
    // prevent — echoing 100kg straight through for a 12-rep set.
    const kg = estimateWorkingWeightKg(100, 5, 10, 2);
    expect(kg).toBeLessThan(100);
    expect(kg).toBeGreaterThan(60);
    // Roughly 70% of e1RM (116.67) is the textbook ~10RM ballpark.
    expect(kg / 116.67).toBeGreaterThan(0.65);
    expect(kg / 116.67).toBeLessThan(0.80);
  });

  it('WORKED EXAMPLE: Deadlift 140kg x 5 → a much smaller conversion delta (target range 5-8 is close to the entered reps)', () => {
    // targetReps = targetRepsFromRange('5-8') = 7
    // e1RM = 140 * (1 + 5/30) = 163.33
    // effective failure reps = 7 + 2 = 9
    // raw = 163.33 / (1 + 9/30) = 163.33 / 1.3 = 125.64 → rounds to 125
    const kg = estimateWorkingWeightKg(140, 5, 7, 2);
    expect(kg).toBe(125);
    // Much closer to the entered weight than the bench example, because
    // the target rep range sits near the entered rep count.
    expect(kg / 140).toBeGreaterThan(0.85);
  });

  it('higher assumedRir produces a lighter seed (more reps in reserve = less weight)', () => {
    // Larger entered weight so the underlying differences survive 2.5kg
    // plate rounding (100kg's rir2/rir3 raw values round to the same
    // plate — a rounding artifact, not evidence the formula is flat).
    const rir1 = estimateWorkingWeightKg(200, 5, 10, 1);
    const rir2 = estimateWorkingWeightKg(200, 5, 10, 2);
    const rir3 = estimateWorkingWeightKg(200, 5, 10, 3);
    expect(rir1).toBeGreaterThan(rir2);
    expect(rir2).toBeGreaterThan(rir3);
  });

  it('a higher target rep count produces a lighter seed', () => {
    const forTen = estimateWorkingWeightKg(100, 5, 10);
    const forFifteen = estimateWorkingWeightKg(100, 5, 15);
    expect(forFifteen).toBeLessThan(forTen);
  });

  it('rounds to the same 2.5kg plate grid as prescribeLoad', () => {
    const kg = estimateWorkingWeightKg(83, 6, 10, 2);
    expect(kg % 2.5).toBe(0);
  });

  it('returns 0 (not seedable) for non-positive inputs rather than a negative/NaN weight', () => {
    expect(estimateWorkingWeightKg(0, 5, 10)).toBe(0);
    expect(estimateWorkingWeightKg(100, 0, 10)).toBe(0);
    expect(estimateWorkingWeightKg(100, 5, 0)).toBe(0);
    expect(estimateWorkingWeightKg(-10, 5, 10)).toBe(0);
  });
});

// ── buildAnchorSeedRows — the exercise_logs seeding contract ───────────

describe('buildAnchorSeedRows', () => {
  const todayIso = '2026-07-02';

  it('every anchor is independently optional — an empty input produces zero rows', () => {
    const { rows, notes } = buildAnchorSeedRows({ anchors: {}, todayIso });
    expect(rows).toEqual([]);
    expect(notes).toEqual({});
  });

  it('skips null/undefined entries without throwing', () => {
    const { rows } = buildAnchorSeedRows({
      anchors: { bench: null, squat: undefined },
      todayIso,
    });
    expect(rows).toEqual([]);
  });

  it('maps each onboarding key to its canonical catalog exercise_name', () => {
    const { rows } = buildAnchorSeedRows({
      anchors: {
        bench: { weightKg: 100, reps: 5 },
        squat: { weightKg: 120, reps: 5 },
        deadlift: { weightKg: 140, reps: 5 },
        overhead: { weightKg: 60, reps: 5 },
        row: { weightKg: 80, reps: 5 },
      },
      todayIso,
    });
    const byName = Object.fromEntries(rows.map(r => [r.exercise_name, r]));
    expect(Object.keys(byName).sort()).toEqual([
      'Barbell Bench Press',
      'Barbell Row',
      'Barbell Squat',
      'Deadlift',
      'Overhead Press',
    ].sort());
  });

  it('every seeded row is stamped with the assumed RIR and is_recovery: false', () => {
    const { rows } = buildAnchorSeedRows({
      anchors: { bench: { weightKg: 100, reps: 5 } },
      todayIso,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].reps_in_reserve).toBe(ANCHOR_SEED_RIR);
    expect(rows[0].is_recovery).toBe(false);
  });

  it('logged_date is dated ANCHOR_SEED_DAYS_AGO in the past — reads as history, not today', () => {
    const { rows } = buildAnchorSeedRows({
      anchors: { bench: { weightKg: 100, reps: 5 } },
      todayIso,
    });
    expect(rows[0].logged_date).toBe('2026-06-25'); // 2026-07-02 minus 7 days
    expect(rows[0].logged_date).not.toBe(todayIso);
    expect(ANCHOR_SEED_DAYS_AGO).toBe(7);
  });

  it('weight_kg is the CONVERTED working weight, not the raw entered weight', () => {
    const { rows } = buildAnchorSeedRows({
      anchors: { bench: { weightKg: 100, reps: 5 } },
      todayIso,
    });
    // Matches the estimateWorkingWeightKg worked example (Bench, 8-12 → 10).
    expect(rows[0].weight_kg).toBe(82.5);
    expect(rows[0].weight_kg).not.toBe(100);
  });

  it('produces no workout_sessions-shaped fields — history only, never a session', () => {
    const { rows } = buildAnchorSeedRows({
      anchors: { bench: { weightKg: 100, reps: 5 } },
      todayIso,
    });
    const row = rows[0] as unknown as Record<string, unknown>;
    expect(row.completed).toBeUndefined();
    expect(row.planned_date).toBeUndefined();
    expect(row.workout_type).toBeUndefined();
  });

  it('the notes map preserves the RAW entered numbers (for the "based on your X×Y" line), keyed by canonical exercise_name', () => {
    const { notes } = buildAnchorSeedRows({
      anchors: { bench: { weightKg: 100, reps: 5 } },
      todayIso,
    });
    expect(notes['Barbell Bench Press']).toEqual({
      enteredWeightKg: 100,
      enteredReps: 5,
      loggedDate: '2026-06-25',
    });
  });

  it('a mix of filled and skipped anchors only produces rows for the filled ones', () => {
    const { rows, notes } = buildAnchorSeedRows({
      anchors: {
        bench: { weightKg: 100, reps: 5 },
        squat: null,
        deadlift: undefined,
      },
      todayIso,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].exercise_name).toBe('Barbell Bench Press');
    expect(Object.keys(notes)).toEqual(['Barbell Bench Press']);
  });

  it('every ANCHOR_LIFTS entry name is a name that exists in the exercise catalog', () => {
    // Guards against the mapping drifting from the catalog (a rename in
    // exercises.ts would otherwise silently produce un-normalizable rows).
    const catalogNames = new Set(EXERCISES.map(e => e.name));
    for (const def of ANCHOR_LIFTS) {
      expect(catalogNames.has(def.exerciseName)).toBe(true);
    }
  });
});
