// Unit tests for the Training Status engine. The whole point of this module
// is that it reads the TREND, never a single day — so the corner that gets
// the most coverage is "a single hard/low day does NOT flip the state."

import {
  computeCalibration,
  computeTrainingStatus,
  decideDeloadOffer,
  deloadProximityNote,
  hasTrainingSignal,
  CALIBRATION_SESSIONS_NEEDED,
  type TrainingStatusInputs,
} from './trainingStatus';

function inputs(overrides: Partial<TrainingStatusInputs> = {}): TrainingStatusInputs {
  return {
    liftDeltas: [],
    completedSessions: 0,
    plannedSessions: 0,
    lowEnergySessions: 0,
    ratedEnergySessions: 0,
    ratedSets: 0,
    rirMissSets: 0,
    ...overrides,
  };
}

// The state is ALWAYS the band of the score. This mirror lives in the test
// so we can assert the engine's number and label never disagree.
function bandOf(score: number | null): 'unknown' | 'backing_off' | 'holding_steady' | 'recovering_well' {
  if (score == null) return 'unknown';
  if (score < 40) return 'backing_off';
  if (score <= 70) return 'holding_steady';
  return 'recovering_well';
}

// Reusable representative inputs, each engineered to land in one band.
const REC = inputs({
  liftDeltas: [
    { name: 'Squat', deltaKg: 5 },
    { name: 'Bench', deltaKg: 2.5 },
  ],
  completedSessions: 9,
  plannedSessions: 10,
  ratedSets: 20,
  rirMissSets: 4, // 20% — on target
  ratedEnergySessions: 6,
  lowEnergySessions: 0,
});

const HOLD_FATIGUE = inputs({
  liftDeltas: [{ name: 'Squat', deltaKg: 2.5 }],
  completedSessions: 8,
  plannedSessions: 10,
  lowEnergySessions: 2, // repeated low energy pulls recovery down to the middle
  ratedEnergySessions: 6,
  ratedSets: 16,
  rirMissSets: 4, // 25% — fine
});

const BACK = inputs({
  liftDeltas: [{ name: 'Squat', deltaKg: 0 }],
  completedSessions: 7,
  plannedSessions: 10,
  lowEnergySessions: 3, // repeated low energy
  ratedEnergySessions: 5,
  ratedSets: 12,
  rirMissSets: 8, // 67% miss — both fatigue signals firing
});

describe('computeTrainingStatus — score lands in the right band', () => {
  it('🟢 recovering_well > 70 — lifts climbing, recovered, adherence fine', () => {
    const r = computeTrainingStatus(REC);
    expect(r.score).toBe(93);
    expect(r.state).toBe('recovering_well');
    expect(r.score!).toBeGreaterThan(70);
    expect(r.topMover).toEqual({ name: 'Squat', deltaKg: 5 });
    // Reads as a RECOVERY verdict, not a strength flex: strength is a generic
    // contributing clause ("trending up"), the recovery read leads to the
    // verdict, and no specific lift is named as a headline.
    expect(r.reason).toMatch(/trending up/i);
    expect(r.reason).toMatch(/energy's steady/i);
    expect(r.reason).toMatch(/well recovered/i);
    expect(r.reason).not.toMatch(/Squat/); // no "+5 kg Squat" flex headline
    // Measured inputs only — never invented physiology.
    expect(r.reason).not.toMatch(/nervous system|cns/i);
  });

  it('🟡 holding_steady 40–70 — repeated low energy pulls the recovery half down', () => {
    const r = computeTrainingStatus(HOLD_FATIGUE);
    expect(r.score).toBe(69);
    expect(r.state).toBe('holding_steady');
    expect(r.score!).toBeGreaterThanOrEqual(40);
    expect(r.score!).toBeLessThanOrEqual(70);
    expect(r.reason).toMatch(/dipped 2 sessions/i);
    expect(r.reason).toMatch(/hold steady/i);
  });

  it('🟡 holding_steady — flat lifts + poor adherence (consistency is the driver)', () => {
    // 3 completed clears the calibration gate (a week of training); the very
    // low adherence ratio is what drags the performance half down into holding.
    const r = computeTrainingStatus(
      inputs({
        liftDeltas: [{ name: 'Squat', deltaKg: 0 }],
        completedSessions: 3,
        plannedSessions: 20, // 15% adherence drags the performance half down
      }),
    );
    expect(r.state).toBe('holding_steady');
    expect(r.score!).toBeGreaterThanOrEqual(40);
    expect(r.score!).toBeLessThanOrEqual(70);
    expect(r.reason).toMatch(/3 of 20 sessions/i);
    expect(r.reason).toMatch(/hold steady/i);
  });

  it('🔴 backing_off < 40 — repeated low energy stacked with a high RIR-miss rate', () => {
    const r = computeTrainingStatus(BACK);
    expect(r.score).toBe(29);
    expect(r.state).toBe('backing_off');
    expect(r.score!).toBeLessThan(40);
    expect(r.reason).toMatch(/back off and recover/i);
    expect(r.reason).toMatch(/energy's down|targets are slipping/i);
  });

  it('🔴 backing_off — multiple declining lifts AND repeated fatigue', () => {
    const r = computeTrainingStatus(
      inputs({
        liftDeltas: [
          { name: 'Squat', deltaKg: -5 },
          { name: 'Deadlift', deltaKg: -5 },
        ],
        completedSessions: 5,
        plannedSessions: 10,
        lowEnergySessions: 3,
        ratedEnergySessions: 5,
        ratedSets: 12,
        rirMissSets: 7,
      }),
    );
    expect(r.state).toBe('backing_off');
    expect(r.score!).toBeLessThan(40);
    expect(r.reason).toMatch(/back off and recover/i);
  });

  it('declining lifts WITHOUT fatigue read as holding, not backing (recovery is fine)', () => {
    // The recovery half is full when there's no fatigue signal, so a rough
    // strength block alone can't tank the score below 40 — that's the
    // earlier-warning half doing its job: it only drops on real fatigue.
    const r = computeTrainingStatus(
      inputs({
        liftDeltas: [
          { name: 'Squat', deltaKg: -5 },
          { name: 'Deadlift', deltaKg: -10 },
          { name: 'Bench', deltaKg: 0 },
        ],
        completedSessions: 8,
        plannedSessions: 10,
        ratedSets: 18,
        rirMissSets: 6, // 33% — under tolerance
        ratedEnergySessions: 6,
        lowEnergySessions: 0,
      }),
    );
    expect(r.state).toBe('holding_steady');
    expect(r.liftsDeclining).toBe(2);
  });
});

describe('computeTrainingStatus — band-derived state can never contradict the score', () => {
  it('state always equals the band of the score across a wide sweep', () => {
    const lifts = [
      [],
      [{ name: 'A', deltaKg: 5 }],
      [{ name: 'A', deltaKg: -5 }],
      [{ name: 'A', deltaKg: 5 }, { name: 'B', deltaKg: -5 }],
      [{ name: 'A', deltaKg: 5 }, { name: 'B', deltaKg: 5 }, { name: 'C', deltaKg: -2.5 }],
    ];
    for (const liftDeltas of lifts) {
      for (let completed = 0; completed <= 10; completed += 2) {
        for (let low = 0; low <= 4; low++) {
          for (const [ratedSets, rirMissSets] of [[0, 0], [12, 2], [16, 10], [20, 14]]) {
            const r = computeTrainingStatus(
              inputs({
                liftDeltas,
                completedSessions: completed,
                plannedSessions: 10,
                lowEnergySessions: low,
                ratedEnergySessions: low + 2,
                ratedSets,
                rirMissSets,
              }),
            );
            expect(r.state).toBe(bandOf(r.score));
          }
        }
      }
    }
  });
});

describe('computeTrainingStatus — repetition gate (no same-day spike/tank)', () => {
  it('a SINGLE low-energy day does not move the score at all (first low day is free)', () => {
    const zero = computeTrainingStatus({ ...REC, lowEnergySessions: 0 });
    const one = computeTrainingStatus({ ...REC, lowEnergySessions: 1 });
    expect(one.score).toBe(zero.score); // exactly equal — the gate holds
    expect(one.state).toBe('recovering_well');
  });

  it('repeated low energy (≥2) is what actually bites', () => {
    const one = computeTrainingStatus({ ...REC, lowEnergySessions: 1 })!.score!;
    const two = computeTrainingStatus({ ...REC, lowEnergySessions: 2 })!.score!;
    const three = computeTrainingStatus({ ...REC, lowEnergySessions: 3 })!.score!;
    expect(two).toBeLessThan(one);
    expect(three).toBeLessThan(two);
  });

  it('a single PR does not spike the score across a band', () => {
    // Same fatigued (backing) profile, with and without one extra big PR.
    const base = computeTrainingStatus(BACK)!.score!;
    const withPr = computeTrainingStatus({
      ...BACK,
      liftDeltas: [{ name: 'Squat', deltaKg: 0 }, { name: 'NewPR', deltaKg: 30 }],
    });
    // The PR nudges the score up, but fatigue dominates — it stays 🔴, it does
    // NOT leap to 🟢.
    expect(withPr.score! - base).toBeLessThan(12);
    expect(withPr.state).not.toBe('recovering_well');
  });

  it('a few RIR misses under tolerance never tank a strong trend', () => {
    const r = computeTrainingStatus(
      inputs({
        liftDeltas: [{ name: 'Squat', deltaKg: 5 }],
        completedSessions: 9,
        plannedSessions: 10,
        ratedSets: 18,
        rirMissSets: 5, // ~28% — below tolerance
        ratedEnergySessions: 6,
        lowEnergySessions: 0,
      }),
    );
    expect(r.state).toBe('recovering_well');
    expect(r.score!).toBeGreaterThan(70);
  });
});

describe('computeTrainingStatus — new user / insufficient data', () => {
  it('no trend window → score null + state unknown (UI shows "Building", not 50)', () => {
    const r = computeTrainingStatus(inputs());
    expect(r.score).toBeNull();
    expect(r.state).toBe('unknown');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('plan rows but zero completed work + no logs is still null/unknown', () => {
    const r = computeTrainingStatus(inputs({ plannedSessions: 3, completedSessions: 0 }));
    expect(r.score).toBeNull();
    expect(r.state).toBe('unknown');
  });
});

describe('computeTrainingStatus — robustness', () => {
  it('never throws on garbage / negative inputs', () => {
    const r = computeTrainingStatus(
      inputs({
        liftDeltas: [{ name: 'X', deltaKg: NaN as unknown as number }],
        completedSessions: -5,
        plannedSessions: -2,
        ratedSets: -1,
        rirMissSets: -3,
      }),
    );
    expect(['unknown', 'holding_steady', 'recovering_well', 'backing_off']).toContain(r.state);
    expect(r.state).toBe(bandOf(r.score));
  });

  it('deterministic: same input → same result', () => {
    const i = inputs({ liftDeltas: [{ name: 'Squat', deltaKg: 5 }], ratedSets: 10, rirMissSets: 2 });
    expect(computeTrainingStatus(i)).toEqual(computeTrainingStatus(i));
  });
});

describe('decideDeloadOffer', () => {
  it("offers 'early' when 🔴 before week 4 and not already deloading", () => {
    expect(decideDeloadOffer({ state: 'backing_off', blockWeek: 3, activeIsDeload: false })).toBe('early');
    expect(decideDeloadOffer({ state: 'backing_off', blockWeek: 1, activeIsDeload: false })).toBe('early');
  });

  it("does NOT offer 'early' when already deloading, or when not 🔴", () => {
    expect(decideDeloadOffer({ state: 'backing_off', blockWeek: 3, activeIsDeload: true })).toBeNull();
    expect(decideDeloadOffer({ state: 'holding_steady', blockWeek: 3, activeIsDeload: false })).toBeNull();
    expect(decideDeloadOffer({ state: 'recovering_well', blockWeek: 2, activeIsDeload: false })).toBeNull();
  });

  it("offers 'skip' only when entering a scheduled week-4 deload while strongly 🟢", () => {
    expect(decideDeloadOffer({ state: 'recovering_well', blockWeek: 4, activeIsDeload: true })).toBe('skip');
    // Default is to KEEP the deload: any non-🟢 state gets no skip offer.
    expect(decideDeloadOffer({ state: 'holding_steady', blockWeek: 4, activeIsDeload: true })).toBeNull();
    expect(decideDeloadOffer({ state: 'backing_off', blockWeek: 4, activeIsDeload: true })).toBeNull();
    // Week 4 but the row isn't actually a deload yet → nothing to skip.
    expect(decideDeloadOffer({ state: 'recovering_well', blockWeek: 4, activeIsDeload: false })).toBeNull();
  });

  it('null/out-of-range blockWeek → no offer', () => {
    expect(decideDeloadOffer({ state: 'backing_off', blockWeek: null, activeIsDeload: false })).toBeNull();
    expect(decideDeloadOffer({ state: 'recovering_well', blockWeek: 9, activeIsDeload: true })).toBeNull();
  });
});

describe('deloadProximityNote', () => {
  it('renders a day countdown, singular/plural', () => {
    expect(deloadProximityNote(5)).toBe('A deload lands in 5 days.');
    expect(deloadProximityNote(1)).toBe('A deload lands in 1 day.');
  });
  it('null when no upcoming deload', () => {
    expect(deloadProximityNote(0)).toBeNull();
    expect(deloadProximityNote(null)).toBeNull();
    expect(deloadProximityNote(undefined)).toBeNull();
  });
});

// The calibration UI's whole honesty contract: its "unlocked" must flip on
// the EXACT transition where the engine stops returning 'unknown'. These
// tests pin that lockstep so a future tweak to either side can't desync them.
describe('computeCalibration — unlock flips with the engine, never before/after', () => {
  // A representative sweep spanning the session-count boundary plus the other
  // (now non-gating) signal shapes — a lift / rated set / energy session with
  // too few completed sessions must stay LOCKED, because the gate is a week of
  // training, not "any signal".
  const cases: TrainingStatusInputs[] = [
    inputs(), // fresh account — nothing logged
    inputs({ completedSessions: 1 }), // one session — still calibrating (fallback)
    inputs({ completedSessions: 2 }), // two — one to go (fallback)
    inputs({ completedSessions: 3 }), // a week of training — unlocks (fallback)
    inputs({ completedSessions: 5 }), // well past the gate (fallback)
    inputs({ liftDeltas: [{ name: 'Squat', deltaKg: 5 }] }), // a lift but 0 sessions → locked
    inputs({ ratedSets: 12, ratedEnergySessions: 2 }), // logs but 0 sessions → locked
    inputs({ completedSessions: 3, ratedEnergySessions: 3, ratedSets: 12, liftDeltas: [{ name: 'Bench', deltaKg: 2.5 }] }),
    // Sticky lifetime gate (provided → authoritative over the recent window):
    inputs({ completedSessions: 0, lifetimeCompletedSessions: 0 }), // new user, locked
    inputs({ completedSessions: 1, lifetimeCompletedSessions: 2 }), // still calibrating
    inputs({ completedSessions: 1, lifetimeCompletedSessions: 3 }), // thin week but unlocked
    inputs({ completedSessions: 1, lifetimeCompletedSessions: 30 }), // established → unlocked
    inputs({ completedSessions: 9, lifetimeCompletedSessions: 2 }), // lifetime overrides recent → locked
    REC, HOLD_FATIGUE, BACK,
  ];

  it('unlocked === (engine state !== unknown) for every case', () => {
    for (const c of cases) {
      const engineKnown = computeTrainingStatus(c).state !== 'unknown';
      expect(computeCalibration(c).unlocked).toBe(engineKnown);
      // And the engine's score is null iff and only iff still calibrating.
      expect(computeTrainingStatus(c).score == null).toBe(!engineKnown);
    }
  });

  it('hasTrainingSignal is the single shared gate', () => {
    for (const c of cases) {
      expect(hasTrainingSignal(c)).toBe(computeTrainingStatus(c).state !== 'unknown');
    }
  });

  it('engine is unknown below 3 sessions and live at/after 3', () => {
    expect(computeTrainingStatus(inputs({ completedSessions: 0 })).state).toBe('unknown');
    expect(computeTrainingStatus(inputs({ completedSessions: 1 })).state).toBe('unknown');
    expect(computeTrainingStatus(inputs({ completedSessions: 2 })).state).toBe('unknown');
    expect(computeTrainingStatus(inputs({ completedSessions: 3 })).state).not.toBe('unknown');
    expect(computeTrainingStatus(inputs({ completedSessions: 3 })).score).not.toBeNull();
  });

  it('remaining counts down 3 → 2 → 1 → unlocked as real sessions accrue', () => {
    const at0 = computeCalibration(inputs({ completedSessions: 0 }));
    expect(at0).toMatchObject({ unlocked: false, sessionsNeeded: CALIBRATION_SESSIONS_NEEDED, sessionsLogged: 0, remaining: 3 });

    const at1 = computeCalibration(inputs({ completedSessions: 1 }));
    expect(at1).toMatchObject({ unlocked: false, sessionsLogged: 1, remaining: 2 });

    const at2 = computeCalibration(inputs({ completedSessions: 2 }));
    expect(at2).toMatchObject({ unlocked: false, sessionsLogged: 2, remaining: 1 });

    const at3 = computeCalibration(inputs({ completedSessions: 3 }));
    expect(at3).toMatchObject({ unlocked: true, sessionsLogged: 3, remaining: 0 });

    // Past the gate the progress stays capped at the target (no overshoot).
    const at5 = computeCalibration(inputs({ completedSessions: 5 }));
    expect(at5).toMatchObject({ unlocked: true, sessionsLogged: 3, remaining: 0 });
  });

  it('a lift / logs with too few sessions stays locked (the gate is sessions, not signals)', () => {
    expect(computeCalibration(inputs({ liftDeltas: [{ name: 'Squat', deltaKg: 5 }] })).unlocked).toBe(false);
    expect(computeCalibration(inputs({ ratedSets: 20, ratedEnergySessions: 2 })).unlocked).toBe(false);
  });
});

// Sticky calibration: the unlock is a ONE-TIME onboarding gate. An established
// user who logs a thin recent fortnight must NOT revert to "Calibrating".
describe('computeCalibration / engine — sticky lifetime gate never re-locks', () => {
  it('an established user with a thin recent window stays live (not re-locked)', () => {
    // Recent window has just 1 session, but lifetime is well past the gate.
    const thin = inputs({ completedSessions: 1, plannedSessions: 6, lifetimeCompletedSessions: 20 });
    expect(computeCalibration(thin).unlocked).toBe(true);
    const r = computeTrainingStatus(thin);
    expect(r.state).not.toBe('unknown');
    expect(r.score).not.toBeNull(); // score reads the recent window — thin, but real
  });

  it('a brand-new user still calibrates and unlocks at the third session', () => {
    // On the way in, lifetime == the user's total, so it counts up 3 → 2 → 1.
    for (let n = 0; n <= 2; n++) {
      const cal = computeCalibration(inputs({ completedSessions: n, lifetimeCompletedSessions: n }));
      expect(cal.unlocked).toBe(false);
      expect(cal.remaining).toBe(3 - n);
      expect(computeTrainingStatus(inputs({ completedSessions: n, lifetimeCompletedSessions: n })).state).toBe('unknown');
    }
    const at3 = computeCalibration(inputs({ completedSessions: 3, lifetimeCompletedSessions: 3 }));
    expect(at3).toMatchObject({ unlocked: true, remaining: 0, sessionsLogged: 3 });
    expect(computeTrainingStatus(inputs({ completedSessions: 3, lifetimeCompletedSessions: 3 })).state).not.toBe('unknown');
  });

  it('lifetime is authoritative when provided, else falls back to the recent window', () => {
    // Provided lifetime below threshold → locked even with a fat recent window.
    expect(computeCalibration(inputs({ completedSessions: 9, lifetimeCompletedSessions: 2 })).unlocked).toBe(false);
    expect(computeTrainingStatus(inputs({ completedSessions: 9, lifetimeCompletedSessions: 2 })).state).toBe('unknown');
    // Omitted → back-compat fallback to recent completedSessions.
    expect(computeCalibration(inputs({ completedSessions: 3 })).unlocked).toBe(true);
    expect(computeCalibration(inputs({ completedSessions: 2 })).unlocked).toBe(false);
  });

  it('lockstep holds for the sticky predicate (unlocked === engine !== unknown)', () => {
    for (const lifetime of [0, 1, 2, 3, 8, 50]) {
      for (const recent of [0, 1, 5]) {
        const c = inputs({ completedSessions: recent, lifetimeCompletedSessions: lifetime });
        expect(computeCalibration(c).unlocked).toBe(computeTrainingStatus(c).state !== 'unknown');
        expect(hasTrainingSignal(c)).toBe(computeTrainingStatus(c).score != null);
      }
    }
  });
});
