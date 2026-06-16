// Deterministic next-session load prescription from last session's RIR.
// APRE-style autoregulation: if reps were left in reserve, climb; if failure
// was hit, hold or back off. Readiness (today's energy) only pulls DOWN —
// it never inflates a recommendation on a good day, because energy is a
// noisy self-report and should protect, not push.
//
// This is pure code on purpose. The LLM in replan-today is good at picking
// WHICH accessory to drop and writing the reasoning line; it is not good at
// arithmetic. Load math lives here, gets unit-tested, never silently
// regresses.

export interface PrescriptionInput {
  /** Most recent logged weight for this exercise, in kg. */
  lastWeightKg: number;
  /** Most recent RIR (0..5). null = unknown, repeat last load. */
  lastRir: number | null;
  /** Today's energy self-report (1..5). */
  energyScore: number;
  /** Compounds tolerate larger jumps than isolations. */
  isCompound: boolean;
  /**
   * Optional. Novices systematically under-rate effort (they think they have
   * 2 reps left when they have 5), so we halve the step for beginners. The
   * energy down-modifier remains a separate safety net.
   */
  fitnessLevel?: 'beginner' | 'intermediate' | 'advanced';
}

export interface Prescription {
  suggestedWeightKg: number;
  /** Signed proportion of lastWeightKg. For analytics + delta labels. */
  deltaPct: number;
  rationale: 'progress' | 'hold' | 'backoff' | 'no_history';
  /**
   * Why we landed on this rationale. The coach line uses this to pick the
   * right narrative — a backoff from a true failure (lastRir === 0) earns
   * the "hit the wall" framing, while a backoff from the low-energy
   * down-modifier earns the "easing back today" framing. Without this,
   * the two cases were indistinguishable and the low-energy day got told
   * "tough one last time" even when last time was fine.
   *
   *   'failure'    — lastRir === 0; engine backed off 5% on its own.
   *   'low_energy' — energy ≤ 2; the down-modifier converted progress to
   *                  hold or hold to backoff. Last session was fine.
   *   'rir'        — the rationale follows directly from the RIR ladder
   *                  (no failure, no low-energy override).
   *   'unknown'    — no history yet (rationale: 'no_history').
   */
  cause: 'failure' | 'low_energy' | 'rir' | 'unknown';
}

/** Round to the nearest loadable increment (2.5 kg standard plate math). */
function roundToPlate(kg: number, step = 2.5): number {
  return Math.max(step, Math.round(kg / step) * step);
}

export function prescribeLoad(input: PrescriptionInput): Prescription {
  const { lastWeightKg, lastRir, energyScore, isCompound, fitnessLevel } = input;

  if (!lastWeightKg || lastWeightKg <= 0) {
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'no_history', cause: 'unknown' };
  }

  if (lastRir === null) {
    // No effort signal → repeat last load, let RIR accrue next time.
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'hold', cause: 'rir' };
  }

  // Base step from RIR. Compounds tolerate larger jumps than isolations.
  // Beginners get the step halved (RIR self-reports are noisy at first).
  const beginnerScale = fitnessLevel === 'beginner' ? 0.5 : 1;
  const up = (isCompound ? 0.05 : 0.025) * beginnerScale; // +5% compound / +2.5% isolation

  let deltaPct: number;
  let rationale: Prescription['rationale'];
  let cause: Prescription['cause'];

  if (lastRir >= 3) {
    deltaPct = up;        // too easy → climb
    rationale = 'progress';
    cause = 'rir';
  } else if (lastRir === 2) {
    deltaPct = up / 2;    // target zone → small bump
    rationale = 'progress';
    cause = 'rir';
  } else if (lastRir === 1) {
    deltaPct = 0;         // hard → repeat
    rationale = 'hold';
    cause = 'rir';
  } else {
    deltaPct = -0.05;     // failure → back off 5%
    rationale = 'backoff';
    cause = 'failure';    // true failure backoff — earns the "hit the wall" framing
  }

  // Readiness modifier: only pulls DOWN on bad days, never inflates on good ones.
  // When this branch fires, the cause is the low-energy override, NOT the RIR
  // signal — the coach line uses `cause` to avoid telling a user with a clean
  // last session "tough one last time" just because today is low energy.
  if (energyScore <= 2 && deltaPct > 0) {
    deltaPct = 0;                    // low energy cancels a planned increase
    rationale = 'hold';
    cause = 'low_energy';
  } else if (energyScore <= 2 && rationale === 'hold' && cause === 'rir') {
    deltaPct = -0.05;                // and lightens a hold slightly
    rationale = 'backoff';
    cause = 'low_energy';
  }

  const raw = lastWeightKg * (1 + deltaPct);
  return {
    suggestedWeightKg: roundToPlate(raw),
    deltaPct,
    rationale,
    cause,
  };
}

// ── Outcome scoring (used by the prescription_outcome event) ───────────
// Pure functions so the math is unit-tested and identical wherever it runs.

/** Did the user log within one plate (±2.5kg) of the suggestion? */
export function wasFollowed(suggestedKg: number, loggedKg: number): boolean {
  return Math.abs(loggedKg - suggestedKg) <= 2.5;
}

/** Did the set land in the autoregulation sweet spot (1–2 RIR)? */
export function hitTargetZone(rir: number | null): boolean {
  return rir === 1 || rir === 2;
}
