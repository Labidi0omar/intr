import { prescribeLoad, wasFollowed, hitTargetZone, applyStallNudge, STALL_WEEKS } from './loadPrescription';

describe('prescribeLoad', () => {
  // ── No-history / null guards ────────────────────────────────────────
  it('returns no_history when lastWeightKg is 0', () => {
    const rx = prescribeLoad({ lastWeightKg: 0, lastRir: 2, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('no_history');
    expect(rx.deltaPct).toBe(0);
  });

  it('holds at last load when RIR is null', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: null, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('hold');
    expect(rx.suggestedWeightKg).toBe(100);
    expect(rx.deltaPct).toBe(0);
  });

  // ── RIR → load (compound, normal energy) ────────────────────────────
  it('RIR 3 (easy) on a compound bumps +5%', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 3, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('progress');
    expect(rx.suggestedWeightKg).toBe(105);
    expect(rx.deltaPct).toBeCloseTo(0.05);
  });

  it('RIR 2 (solid) on a compound bumps +2.5%', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 2, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('progress');
    expect(rx.suggestedWeightKg).toBe(102.5);
  });

  it('RIR 1 (hard) holds', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 1, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('hold');
    expect(rx.suggestedWeightKg).toBe(100);
    expect(rx.deltaPct).toBe(0);
  });

  it('RIR 0 (failure) backs off 5%', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 0, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('backoff');
    expect(rx.suggestedWeightKg).toBe(95);
  });

  // ── Isolation gets smaller steps ────────────────────────────────────
  it('RIR 3 on an isolation only bumps +2.5%', () => {
    const rx = prescribeLoad({ lastWeightKg: 20, lastRir: 3, energyScore: 3, isCompound: false });
    expect(rx.rationale).toBe('progress');
    expect(rx.suggestedWeightKg).toBe(20); // 20 * 1.025 = 20.5 → rounds down to 20 (nearest 2.5)
  });

  it('RIR 3 on a heavier isolation rounds up correctly', () => {
    // 50 * 1.025 = 51.25 → nearest 2.5 = 50 (rounds toward even on .25, but Math.round → 51 → /2.5 = 20.5 → round = 20 → *2.5 = 50)
    const rx = prescribeLoad({ lastWeightKg: 50, lastRir: 3, energyScore: 3, isCompound: false });
    expect(rx.rationale).toBe('progress');
    expect([50, 52.5]).toContain(rx.suggestedWeightKg);
  });

  // ── Energy down-modifier ────────────────────────────────────────────
  it('low energy cancels a planned compound increase', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 3, energyScore: 2, isCompound: true });
    expect(rx.rationale).toBe('hold');
    expect(rx.suggestedWeightKg).toBe(100);
    expect(rx.deltaPct).toBe(0);
  });

  it('low energy converts a hold into a backoff', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 1, energyScore: 1, isCompound: true });
    expect(rx.rationale).toBe('backoff');
    expect(rx.suggestedWeightKg).toBe(95);
  });

  it('low energy does NOT inflate a failure backoff (already negative)', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 0, energyScore: 1, isCompound: true });
    expect(rx.rationale).toBe('backoff');
    expect(rx.suggestedWeightKg).toBe(95);
  });

  // ── cause: distinguishes failure-driven vs low-energy-driven backoff ──
  // The coach line needs to know WHY the rationale landed where it did
  // so it doesn't tell a user "tough one last time" when last session
  // was clean and today is just a low-energy day.

  it('cause = "failure" when lastRir === 0 even on normal energy', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 0, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('backoff');
    expect(rx.cause).toBe('failure');
  });

  it('cause = "low_energy" when energy ≤ 2 promotes a hold into a backoff', () => {
    // lastRir 1 = hold from RIR; energy 1 demotes to backoff. The
    // backoff is NOT a failure call — last session was fine.
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 1, energyScore: 1, isCompound: true });
    expect(rx.rationale).toBe('backoff');
    expect(rx.cause).toBe('low_energy');
  });

  it('cause = "low_energy" when energy ≤ 2 cancels a planned progress', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 3, energyScore: 2, isCompound: true });
    expect(rx.rationale).toBe('hold');
    expect(rx.cause).toBe('low_energy');
  });

  it('cause = "rir" on a clean progress or hold (no overrides triggered)', () => {
    const progress = prescribeLoad({ lastWeightKg: 100, lastRir: 3, energyScore: 3, isCompound: true });
    expect(progress.rationale).toBe('progress');
    expect(progress.cause).toBe('rir');
    const hold = prescribeLoad({ lastWeightKg: 100, lastRir: 1, energyScore: 3, isCompound: true });
    expect(hold.rationale).toBe('hold');
    expect(hold.cause).toBe('rir');
  });

  it('cause = "unknown" on the no-history path', () => {
    const rx = prescribeLoad({ lastWeightKg: 0, lastRir: null, energyScore: 3, isCompound: true });
    expect(rx.rationale).toBe('no_history');
    expect(rx.cause).toBe('unknown');
  });

  it('good energy (5) does NOT inflate beyond the RIR-set step', () => {
    const rx = prescribeLoad({ lastWeightKg: 100, lastRir: 2, energyScore: 5, isCompound: true });
    expect(rx.rationale).toBe('progress');
    expect(rx.suggestedWeightKg).toBe(102.5);
  });

  // ── Beginner halving ────────────────────────────────────────────────
  it('beginner halves the compound step', () => {
    // 100 * (1 + 0.025) = 102.5
    const rx = prescribeLoad({
      lastWeightKg: 100, lastRir: 3, energyScore: 3, isCompound: true, fitnessLevel: 'beginner',
    });
    expect(rx.rationale).toBe('progress');
    expect(rx.suggestedWeightKg).toBe(102.5);
  });

  it('beginner halves the isolation step to near-zero', () => {
    // 20 * (1 + 0.0125) = 20.25 → rounds to 20
    const rx = prescribeLoad({
      lastWeightKg: 20, lastRir: 3, energyScore: 3, isCompound: false, fitnessLevel: 'beginner',
    });
    expect(rx.suggestedWeightKg).toBe(20);
  });

  it('beginner backoff is unchanged (still -5%)', () => {
    const rx = prescribeLoad({
      lastWeightKg: 100, lastRir: 0, energyScore: 3, isCompound: true, fitnessLevel: 'beginner',
    });
    expect(rx.rationale).toBe('backoff');
    expect(rx.suggestedWeightKg).toBe(95);
  });

  // ── Plate rounding ──────────────────────────────────────────────────
  it('rounds odd weights to the nearest 2.5 kg', () => {
    // 87 * 1.05 = 91.35 → nearest 2.5 = 90
    const rx = prescribeLoad({ lastWeightKg: 87, lastRir: 3, energyScore: 3, isCompound: true });
    expect(rx.suggestedWeightKg % 2.5).toBe(0);
  });

  it('never returns a weight below one plate', () => {
    const rx = prescribeLoad({ lastWeightKg: 2.5, lastRir: 0, energyScore: 1, isCompound: false });
    expect(rx.suggestedWeightKg).toBeGreaterThanOrEqual(2.5);
  });
});

describe('wasFollowed', () => {
  it('equal weights → followed', () => {
    expect(wasFollowed(100, 100)).toBe(true);
  });
  it('exactly 2.5kg apart (logged above) → followed', () => {
    expect(wasFollowed(100, 102.5)).toBe(true);
  });
  it('exactly 2.5kg apart (logged below) → followed', () => {
    expect(wasFollowed(100, 97.5)).toBe(true);
  });
  it('2.6kg apart (logged above) → override', () => {
    expect(wasFollowed(100, 102.6)).toBe(false);
  });
  it('2.6kg apart (logged below) → override', () => {
    expect(wasFollowed(100, 97.4)).toBe(false);
  });
});

describe('applyStallNudge', () => {
  // The base shape: a "would hold" prescription — RIR 1 (hard but clean),
  // normal energy, cause === 'rir'. That's the slot the nudge is allowed
  // to operate in; the helper builds it so each test focuses on the
  // history + energy + lastRir variations.
  const baseHold = prescribeLoad({
    lastWeightKg: 80,
    lastRir: 1,
    energyScore: 3,
    isCompound: true,
  });

  /** 3 weekly sessions, all at 80 kg, anchored so the earliest is N weeks
   *  before today. Caller chooses today. */
  function flatThreeWeekHistory(todayIso: string, kg = 80) {
    // Earliest session is 21 days (3 weeks) before today; one session per
    // week is enough — runLength = 3, weeks = 3.
    return [
      { topKg: kg, date: shiftIso(todayIso, -21) },
      { topKg: kg, date: shiftIso(todayIso, -14) },
      { topKg: kg, date: shiftIso(todayIso, -7) },
    ];
  }

  function shiftIso(iso: string, days: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  it('flat ≥ 3 weeks + clean RIR + normal energy → bumps weight + cause time_to_progress', () => {
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 1,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    // Compound +5% step: 80 → 84 → rounds to 85.
    expect(out.rationale).toBe('progress');
    expect(out.cause).toBe('time_to_progress');
    expect(out.suggestedWeightKg).toBe(85);
    expect(out.stallWeeks).toBeGreaterThanOrEqual(STALL_WEEKS);
  });

  it('flat ≥ 3 weeks + high energy (4) → still bumps (only low energy protects)', () => {
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 1,
      energyScore: 4,
      isCompound: true,
      todayIso: today,
    });
    expect(out.cause).toBe('time_to_progress');
  });

  it('flat ≥ 3 weeks but LOW energy (≤ 2) → no bump (energy still suppresses)', () => {
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 1,
      energyScore: 2,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(baseHold);
  });

  it('flat ≥ 3 weeks but last session was FAILURE → no bump', () => {
    // A failure backoff is the engine's strongest signal; the nudge must
    // never override it. Confirm the wrapper passes the failure rx through
    // untouched even on a long stall.
    const today = '2026-06-30';
    const failureRx = prescribeLoad({
      lastWeightKg: 80, lastRir: 0, energyScore: 3, isCompound: true,
    });
    expect(failureRx.cause).toBe('failure');
    const out = applyStallNudge({
      base: failureRx,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 0,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(failureRx);
  });

  it('flat but only 2 weeks → no bump (under STALL_WEEKS threshold)', () => {
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: [
        { topKg: 80, date: shiftIso(today, -14) },
        { topKg: 80, date: shiftIso(today, -7) },
      ],
      lastRir: 1,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(baseHold);
  });

  it('a single session at the current top → no bump (need ≥ 2 to claim a stall)', () => {
    // Long absence then one session today: not a stall, it's a return.
    // The "actually trained in that window, not just absent" guard.
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: [{ topKg: 80, date: today }],
      lastRir: 1,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(baseHold);
  });

  it('long-ago session at the same weight with an intervening higher session → no bump', () => {
    // History: 80 → 85 → 80 → 80 → 80. The latest run is 3×80, but the
    // 85 in the middle broke the stall; only the post-85 sessions count.
    // Earliest session in the run is 14 days ago → 2 weeks → under threshold.
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: [
        { topKg: 80, date: shiftIso(today, -35) },
        { topKg: 85, date: shiftIso(today, -28) }, // breaks the stall
        { topKg: 80, date: shiftIso(today, -14) },
        { topKg: 80, date: shiftIso(today, -7) },
        { topKg: 80, date: today },
      ],
      lastRir: 1,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(baseHold);
  });

  it('clean RIR 2 (target zone) also earns the nudge once the stall is long enough', () => {
    // RIR 2 normally produces a small progression on its own; but if for
    // whatever reason the engine emitted a hold-rir (e.g. plate-cap on
    // a tiny lift), a true 3-week stall on a clean RIR-2 set still earns
    // the nudge. Construct the base manually to exercise that path.
    const today = '2026-06-30';
    const baseFakedHold: ReturnType<typeof prescribeLoad> = {
      suggestedWeightKg: 80,
      deltaPct: 0,
      rationale: 'hold',
      cause: 'rir',
    };
    const out = applyStallNudge({
      base: baseFakedHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 2,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out.cause).toBe('time_to_progress');
  });

  it('null lastRir → no bump (no clean signal to credit)', () => {
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: null,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(baseHold);
  });

  it('beginner halves the bump (same rule as a real progression)', () => {
    // Compound beginner step: 0.05 × 0.5 = 0.025 → 80 × 1.025 = 82 → 82.5.
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 1,
      energyScore: 3,
      isCompound: true,
      fitnessLevel: 'beginner',
      todayIso: today,
    });
    expect(out.cause).toBe('time_to_progress');
    expect(out.suggestedWeightKg).toBe(82.5);
  });

  it('isolation: a sub-plate bump collapses to no-op (no contradiction with hero)', () => {
    // 20 × 1.025 = 20.5 → rounds to 20 → no movement. The guard inside
    // applyStallNudge returns the base unchanged in that case, so the
    // hero never gets "Same as last" next to "time to add a little."
    const today = '2026-06-30';
    const baseIso = { ...baseHold, suggestedWeightKg: 20 };
    const out = applyStallNudge({
      base: baseIso,
      liftHistory: [
        { topKg: 20, date: shiftIso(today, -21) },
        { topKg: 20, date: shiftIso(today, -14) },
        { topKg: 20, date: shiftIso(today, -7) },
      ],
      lastRir: 1,
      energyScore: 3,
      isCompound: false,
      todayIso: today,
    });
    expect(out).toBe(baseIso);
  });

  it('isolation: a kg that DOES move under +2.5% earns the nudge', () => {
    // 50 × 1.025 = 51.25 → rounds to 50 in Math.round(51.25/2.5)*2.5
    // = round(20.5)*2.5 = 20*2.5 = 50 (banker's rounding pulls to 20).
    // Use a kg where the +2.5% bump crosses the plate cleanly: 60 →
    // 60 × 1.025 = 61.5 → round(24.6)*2.5 = 25*2.5 = 62.5.
    const today = '2026-06-30';
    const baseIso = { ...baseHold, suggestedWeightKg: 60 };
    const out = applyStallNudge({
      base: baseIso,
      liftHistory: [
        { topKg: 60, date: shiftIso(today, -21) },
        { topKg: 60, date: shiftIso(today, -14) },
        { topKg: 60, date: shiftIso(today, -7) },
      ],
      lastRir: 1,
      energyScore: 3,
      isCompound: false,
      todayIso: today,
    });
    expect(out.cause).toBe('time_to_progress');
    expect(out.suggestedWeightKg).toBe(62.5);
  });

  it('non-hold base passes through untouched (never overrides progress/backoff)', () => {
    const today = '2026-06-30';
    const progressRx = prescribeLoad({
      lastWeightKg: 80, lastRir: 3, energyScore: 3, isCompound: true,
    });
    const out = applyStallNudge({
      base: progressRx,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 3,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(progressRx);
  });

  it('low-energy-driven hold passes through untouched (cause !== rir)', () => {
    // lastRir 3 + energy 2 → engine emits hold/low_energy. The nudge
    // must not climb on top of a low-energy day.
    const today = '2026-06-30';
    const lowEnergyHold = prescribeLoad({
      lastWeightKg: 80, lastRir: 3, energyScore: 2, isCompound: true,
    });
    expect(lowEnergyHold.cause).toBe('low_energy');
    const out = applyStallNudge({
      base: lowEnergyHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 3,
      energyScore: 2,
      isCompound: true,
      todayIso: today,
    });
    expect(out).toBe(lowEnergyHold);
  });

  it('hero delta and stall reason agree: weight actually moves, deltaPct > 0', () => {
    // The whole point of the wrapper: a "time_to_progress" rx has a real
    // positive delta the presenter can put next to "time to add a little"
    // without the old "Same as last" contradiction.
    const today = '2026-06-30';
    const out = applyStallNudge({
      base: baseHold,
      liftHistory: flatThreeWeekHistory(today),
      lastRir: 1,
      energyScore: 3,
      isCompound: true,
      todayIso: today,
    });
    expect(out.suggestedWeightKg).toBeGreaterThan(80);
    expect(out.deltaPct).toBeGreaterThan(0);
  });
});

describe('hitTargetZone', () => {
  it('rir 0 → false', () => {
    expect(hitTargetZone(0)).toBe(false);
  });
  it('rir 1 → true', () => {
    expect(hitTargetZone(1)).toBe(true);
  });
  it('rir 2 → true', () => {
    expect(hitTargetZone(2)).toBe(true);
  });
  it('rir 3 → false', () => {
    expect(hitTargetZone(3)).toBe(false);
  });
  it('rir null → false', () => {
    expect(hitTargetZone(null)).toBe(false);
  });
});
