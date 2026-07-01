import { classifyCompound, estimateStartingLoad } from './startingLoad';

describe('classifyCompound', () => {
  it('maps known compound names case-insensitively', () => {
    expect(classifyCompound('Barbell Bench Press')).toBe('bench');
    expect(classifyCompound('Incline Barbell Bench Press')).toBe('bench');
    expect(classifyCompound('Barbell Squat')).toBe('squat');
    expect(classifyCompound('deadlift')).toBe('deadlift');
    expect(classifyCompound('Overhead Press')).toBe('overhead');
    expect(classifyCompound('Military Press')).toBe('overhead');
    expect(classifyCompound('Dumbbell Shoulder Press')).toBe('overhead');
    expect(classifyCompound('Barbell Row')).toBe('row');
    expect(classifyCompound('Bent Over Row')).toBe('row');
  });

  it('returns null for isolations and unmapped lifts', () => {
    expect(classifyCompound('Bicep Curl')).toBeNull();
    expect(classifyCompound('Lateral Raise')).toBeNull();
    expect(classifyCompound('Cable Fly')).toBeNull();
    expect(classifyCompound('Leg Press')).toBeNull();
    expect(classifyCompound('Lat Pulldown')).toBeNull();
    expect(classifyCompound('')).toBeNull();
    expect(classifyCompound(null)).toBeNull();
    expect(classifyCompound(undefined)).toBeNull();
  });

  it('does not match "overhead" inside Overhead Tricep Extension', () => {
    // Pinned: "Overhead Tricep Extension" must NOT classify as overhead press.
    // The match key is "overhead press" / "military" / "shoulder press".
    expect(classifyCompound('Overhead Tricep Extension')).toBeNull();
  });
});

describe('estimateStartingLoad', () => {
  // ── Unknown / skipped inputs → null (no fake numbers) ─────────────────
  it('returns null when bodyweight is missing', () => {
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: null, sex: 'male', liftName: 'Barbell Squat' }),
    ).toBeNull();
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: undefined, sex: 'male', liftName: 'Barbell Squat' }),
    ).toBeNull();
  });

  it('returns null when bodyweight is out of plausible range', () => {
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: 10, sex: 'male', liftName: 'Barbell Squat' }),
    ).toBeNull();
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: 500, sex: 'male', liftName: 'Barbell Squat' }),
    ).toBeNull();
  });

  it('returns null for non-finite bodyweight', () => {
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: NaN, sex: 'male', liftName: 'Barbell Squat' }),
    ).toBeNull();
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: Infinity, sex: 'male', liftName: 'Barbell Squat' }),
    ).toBeNull();
  });

  it('returns null for non-compound / unrecognised lifts', () => {
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: 80, sex: 'male', liftName: 'Bicep Curl' }),
    ).toBeNull();
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: 80, sex: 'male', liftName: 'Lateral Raise' }),
    ).toBeNull();
  });

  // ── Beginner male, 80 kg — anchors the rest of the table ──────────────
  // squat:    80 * 0.50 * 1.0 * 1.0 = 40 → floor(40/2.5)*2.5 = 40
  // deadlift: 80 * 0.60 * 1.0 * 1.0 = 48 → 47.5
  // bench:    80 * 0.35 * 1.0 * 1.0 = 28 → 27.5
  // overhead: 80 * 0.25 * 1.0 * 1.0 = 20 → 20 (bar floor)
  // row:      80 * 0.35 * 1.0 * 1.0 = 28 → 27.5
  it('seeds a beginner male @ 80 kg conservatively per compound', () => {
    const base = { level: 'beginner' as const, bodyweightKg: 80, sex: 'male' as const };
    expect(estimateStartingLoad({ ...base, liftName: 'Barbell Squat' })).toBe(40);
    expect(estimateStartingLoad({ ...base, liftName: 'Deadlift' })).toBe(47.5);
    expect(estimateStartingLoad({ ...base, liftName: 'Barbell Bench Press' })).toBe(27.5);
    expect(estimateStartingLoad({ ...base, liftName: 'Overhead Press' })).toBe(20);
    expect(estimateStartingLoad({ ...base, liftName: 'Barbell Row' })).toBe(27.5);
  });

  // ── Always floors to a 2.5 kg plate, never rounds up ──────────────────
  it('floors to a 2.5 kg plate (never rounds up)', () => {
    // 70 * 0.50 = 35 → 35 (exact)
    // 73 * 0.50 = 36.5 → 35 (floor, not 37.5)
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: 73, sex: 'male', liftName: 'Barbell Squat' }),
    ).toBe(35);
  });

  it('never seeds below an empty bar (20 kg floor)', () => {
    // A 30 kg female lifter pressing: 30 * 0.25 * 1.0 * 0.65 = 4.875 → clamped to 20.
    expect(
      estimateStartingLoad({ level: 'beginner', bodyweightKg: 30, sex: 'female', liftName: 'Overhead Press' }),
    ).toBe(20);
  });

  // ── Level scaling: intermediate > beginner, advanced > intermediate ──
  it('scales up by fitness level', () => {
    const beg = estimateStartingLoad({ level: 'beginner', bodyweightKg: 100, sex: 'male', liftName: 'Barbell Squat' });
    const inter = estimateStartingLoad({ level: 'intermediate', bodyweightKg: 100, sex: 'male', liftName: 'Barbell Squat' });
    const adv = estimateStartingLoad({ level: 'advanced', bodyweightKg: 100, sex: 'male', liftName: 'Barbell Squat' });
    // 100 * 0.5 = 50 → 50; *1.4 = 70 → 70; *1.8 = 90 → 90
    expect(beg).toBe(50);
    expect(inter).toBe(70);
    expect(adv).toBe(90);
    expect(adv!).toBeGreaterThan(inter!);
    expect(inter!).toBeGreaterThan(beg!);
  });

  // ── Sex bias: female / unspecified land below male ────────────────────
  it('female and unspecified seed below male for the same lift', () => {
    const male = estimateStartingLoad({ level: 'beginner', bodyweightKg: 70, sex: 'male', liftName: 'Barbell Bench Press' });
    const female = estimateStartingLoad({ level: 'beginner', bodyweightKg: 70, sex: 'female', liftName: 'Barbell Bench Press' });
    const unspec = estimateStartingLoad({ level: 'beginner', bodyweightKg: 70, sex: 'unspecified', liftName: 'Barbell Bench Press' });
    // 70 * 0.35 = 24.5 → floor 22.5. female: 24.5 * 0.65 = 15.925 → clamped 20.
    expect(male).toBe(22.5);
    // unspecified mirrors female (conservative-by-default rule)
    expect(unspec).toBe(female);
    expect(female!).toBeLessThanOrEqual(male!);
  });

  it('null sex is treated as unspecified (conservative)', () => {
    const nullSex = estimateStartingLoad({ level: 'beginner', bodyweightKg: 70, sex: null, liftName: 'Barbell Squat' });
    const unspec = estimateStartingLoad({ level: 'beginner', bodyweightKg: 70, sex: 'unspecified', liftName: 'Barbell Squat' });
    expect(nullSex).toBe(unspec);
  });
});
