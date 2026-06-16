import { prescribeLoad, wasFollowed, hitTargetZone } from './loadPrescription';

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
