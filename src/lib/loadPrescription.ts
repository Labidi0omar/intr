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
//
// Goal-aware (v2): the RIR ladder shifts by lane (profiles.goal). Strength
// targets RIR 1-3 — climb on light sets (3+), hold on clean target sets
// (1-2), only back off on true failure (0). Progression happens on load,
// not on reps to failure. Muscle keeps the current 1-2-hold ladder;
// general is a pure passthrough to the pre-goal engine.
// hitTargetZone(rir, goal) answers the analytics question "was this set
// in the sweet spot" per lane.
// See goalProfile.ts for the dose side of the same feature.
//
// Volume-first (Part 4): the top-of-band gate is universal — once the caller
// knows the plan's rep band and last session's reps, `progress` is downgraded
// to `hold` unless the top of the band was reached. For strength that means
// "add load only when the top set hits the ceiling"; for muscle/general it
// enforces "climb reps within the band before climbing weight." The next-
// session rep target lives in goalProfile.nextVolumeStep — this file only
// decides the weight suggestion.

export type Goal = 'strength' | 'muscle' | 'general';

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
  /** User's training goal (profiles.goal). Shifts the RIR ladder — strength
   *  targets RIR 2-3 (climb only when there's plenty in the tank), muscle
   *  and general keep the current 1-2 target. Omitted → treated as
   *  'general' for a graceful default. */
  goal?: Goal;
  /** Best set's reps last session for this lift. Optional — when omitted,
   *  the top-of-band gate is off and the engine behaves as it did pre-goal
   *  (progress on RIR alone). When set together with `topReps`, progress is
   *  suppressed unless lastReps >= topReps: the "add load only when the
   *  band has been topped" rule. */
  lastReps?: number | null;
  /** Top of the plan's rep band for this lift (e.g. 12 for "8-12", or 5
   *  for a strength "3-5"). Callers parse with goalProfile.parseBand. */
  topReps?: number | null;
  /** Number of prior sessions logged against this specific lift (any
   *  weight, any date). When ≤ CALIBRATION_SESSIONS (or fitnessLevel ===
   *  'beginner'), the calibration damper fires: upward moves are capped to
   *  the smallest step and `lastRir === 0` is treated as "hold" instead
   *  of "failure" — a novice reporting "0 reps left" is far more likely a
   *  miscalibrated 3-4 RIR than a true failure. RIR is a noisy instrument,
   *  worst exactly where it matters most. Undefined → no session-count
   *  damper (only fitnessLevel drives calibration). */
  sessionCountForLift?: number;
}

/** Number of logged sessions per lift below which the calibration damper
 *  fires (RIR treated as unreliable). Advanced lifters new to a specific
 *  lift still get the damper — the noise is about the lift, not the
 *  lifter's overall experience. */
export const CALIBRATION_SESSIONS = 3;

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
   *   'failure'          — lastRir === 0; engine backed off 5% on its own.
   *   'low_energy'       — energy ≤ 2; the down-modifier converted progress
   *                        to hold or hold to backoff. Last session was fine.
   *   'rir'              — the rationale follows directly from the RIR ladder
   *                        (no failure, no low-energy override).
   *   'time_to_progress' — applied by applyStallNudge (additive layer over
   *                        prescribeLoad): the lift sat at the same top
   *                        weight for ≥ STALL_WEEKS while being actually
   *                        trained, the last set was clean, and today's
   *                        energy isn't low. The nudge converts a would-be
   *                        hold into a one-step progression. Earned, not
   *                        forced — never overrides failure or low energy.
   *   'unknown'          — no history yet (rationale: 'no_history').
   */
  cause: 'failure' | 'low_energy' | 'rir' | 'time_to_progress' | 'unknown';
  /** Populated only when cause === 'time_to_progress' — the number of weeks
   *  the lift sat at the same top weight before the stall nudge fired. The
   *  presenter weaves this into the reason line ("held {kg} for {n} weeks").
   *  Optional on every other cause so legacy callers / tests don't need to
   *  set it. */
  stallWeeks?: number;
}

/** Round to the nearest loadable increment (2.5 kg standard plate math).
 *  Exported for src/lib/anchorSeed.ts, which rounds an e1RM-derived
 *  working weight to the same plate grid as every other prescribed kg. */
export function roundToPlate(kg: number, step = 2.5): number {
  return Math.max(step, Math.round(kg / step) * step);
}

/** Threshold (in weeks) at which a clean, well-energised, would-hold lift
 *  earns a stall nudge — converts hold to a one-step progression with cause
 *  'time_to_progress'. See applyStallNudge.
 *
 *  Lowered 3 → 2 in the deload-and-overload PR so the engine's load bump
 *  fires on the SAME 2-week parked-window that the coach's "time to add
 *  weight" nudge (progress_ready observation) triggers on. The shown weight
 *  and the coach copy have to agree by construction — a coach line saying
 *  "add a little" while the workout card still shows the same weight is
 *  the kind of contradiction that erodes trust in the whole system. */
export const STALL_WEEKS = 2;

export function prescribeLoad(input: PrescriptionInput): Prescription {
  const {
    lastWeightKg, lastRir, energyScore, isCompound, fitnessLevel,
    goal, lastReps, topReps, sessionCountForLift,
  } = input;

  if (!lastWeightKg || lastWeightKg <= 0) {
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'no_history', cause: 'unknown' };
  }

  if (lastRir === null) {
    // No effort signal → repeat last load, let RIR accrue next time.
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'hold', cause: 'rir' };
  }

  // Calibration damper — fires for beginners (overall) or for anyone in
  // their first CALIBRATION_SESSIONS on a specific lift. RIR is noisy
  // *exactly* where it matters most: novices under-rate effort (they think
  // they have 2 in reserve when they have 5), and even experienced lifters
  // are miscalibrated on a lift they haven't done before. The damper both
  // halves the step AND reframes lastRir === 0 as "hold" instead of
  // "failure" — a self-reported 0 in that window is much more likely a
  // shaky rep than a real ceiling.
  const inCalibrationWindow =
    fitnessLevel === 'beginner' ||
    (typeof sessionCountForLift === 'number' && sessionCountForLift < CALIBRATION_SESSIONS);

  // Base step from RIR. Compounds tolerate larger jumps than isolations.
  // Novices / early-lift sessions get the step halved.
  const stepScale = inCalibrationWindow ? 0.5 : 1;
  const up = (isCompound ? 0.05 : 0.025) * stepScale;

  // Effective lane. Undefined goal → 'general' (matches ensureCurrentWeekPlan's
  // fallback so the ladder here agrees with the plan's dose).
  const lane: Goal =
    goal === 'strength' || goal === 'muscle' || goal === 'general' ? goal : 'general';

  let deltaPct: number;
  let rationale: Prescription['rationale'];
  let cause: Prescription['cause'];

  if (lane === 'strength') {
    // Strength ladder — target RIR 1-3 (climb when there's plenty in the
    // tank, hold on a clean target set, only back off on true failure).
    // RIR 1 is a good strength set — a clean rep with one in reserve —
    // and holding there is exactly the point of the lane. Only RIR 0
    // (actual failure) drops the load next session.
    if (lastRir >= 3) {
      deltaPct = up;
      rationale = 'progress';
      cause = 'rir';
    } else if (lastRir === 2 || lastRir === 1) {
      deltaPct = 0;                    // target zone — hold, don't push
      rationale = 'hold';
      cause = 'rir';
    } else {
      deltaPct = -0.05;
      rationale = 'backoff';
      cause = 'failure';
    }
  } else {
    // Muscle / general — current 1-2-hold ladder. Muscle's analytics target
    // (0-2 via hitTargetZone) is a WIDER "on target" zone but the ladder
    // still treats an actual RIR 0 as failure — grinding a rep in the gym
    // is different from having targeted proximity to failure, and a real
    // failure earns next-session lightening either way.
    if (lastRir >= 3) {
      deltaPct = up;
      rationale = 'progress';
      cause = 'rir';
    } else if (lastRir === 2) {
      deltaPct = up / 2;
      rationale = 'progress';
      cause = 'rir';
    } else if (lastRir === 1) {
      deltaPct = 0;
      rationale = 'hold';
      cause = 'rir';
    } else {
      deltaPct = -0.05;
      rationale = 'backoff';
      cause = 'failure';
    }
  }

  // Calibration damper's second effect: a novice / new-to-this-lift RIR 0
  // is reframed as "hold" instead of "failure." Only fires when the damper
  // is active — established lifters keep the failure backoff.
  if (inCalibrationWindow && lastRir === 0) {
    deltaPct = 0;
    rationale = 'hold';
    cause = 'rir';
  }

  // Top-of-band gate — universal across lanes when the caller provides
  // both `lastReps` and `topReps`. Suppresses a would-be progress into a
  // hold unless last session's reps hit the top of the rep band. This is
  // the "add load only when the band has been topped" rule.
  //
  // NOTE (product cut): the workout screen no longer captures per-set reps
  // from the user — exercise_logs.reps is auto-populated with the midpoint
  // of the prescribed range for history only, and app/workout.tsx
  // intentionally SKIPS passing lastReps into this call. The gate stays
  // inert in current production (guard needs both inputs); progression is
  // pure RIR-driven. The gate code is kept here so the machinery still
  // works if per-set rep capture is ever brought back.
  const gateActive =
    typeof lastReps === 'number' && Number.isFinite(lastReps) &&
    typeof topReps === 'number' && Number.isFinite(topReps) && topReps > 0;
  if (gateActive && rationale === 'progress' && (lastReps as number) < (topReps as number)) {
    deltaPct = 0;
    rationale = 'hold';
    cause = 'rir';
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

// ── Stall progression nudge (additive layer over prescribeLoad) ──────────
//
// prescribeLoad only moves weight on a last-session RIR signal: clean hard
// reps (RIR 1) → hold, clean light reps (RIR ≥ 2) → climb, failure → back
// off. A lifter who keeps grinding out clean RIR-1 sets at the same weight
// week after week never gets told to add load, because the engine sees no
// "easy" reps to climb from. This wrapper closes that loop: when a lift has
// been parked at the same top weight for ≥ STALL_WEEKS *while actually
// being trained*, the last session was clean (not failure), today's energy
// is normal/high, AND the engine would otherwise hold, bump one normal
// step (same +%/halving rules as a real progression) and tag the cause
// 'time_to_progress'. Because the suggested weight actually moves, the
// hero delta and reason agree — no contradiction. Never overrides failure
// or low_energy: those signals already mean "don't push," and the stall
// nudge respects them. Low energy still suppresses (energy only protects).

export interface StallNudgeInput {
  /** The engine's would-be prescription for this set (pre-nudge). */
  base: Prescription;
  /** Per-session top weight + date for THIS lift, any order. The augment
   *  sorts and walks internally. */
  liftHistory: readonly { topKg: number; date: string }[];
  /** Most recent RIR (0..5). null = unknown — treated as "not clean" so the
   *  nudge stays silent rather than guessing. */
  lastRir: number | null;
  /** Today's energy self-report (1..5). ≤ 2 suppresses the nudge. */
  energyScore: number;
  /** Compounds tolerate larger jumps than isolations (same rule as the
   *  base engine). */
  isCompound: boolean;
  /** Halves the step for beginners (same rule as the base engine). */
  fitnessLevel?: 'beginner' | 'intermediate' | 'advanced';
  /** YYYY-MM-DD anchor for "today" — caller passes so the augment stays
   *  pure / deterministic / unit-testable. */
  todayIso: string;
  /** Override the stall threshold (testing). Defaults to STALL_WEEKS. */
  stallWeeksThreshold?: number;
}

/** Days between two YYYY-MM-DD strings (b − a), never negative. Same math
 *  as coachObservations.daysBetween — duplicated locally so this module
 *  stays standalone. */
function daysBetweenIso(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || pa.some(isNaN) || pb.some(isNaN)) return 0;
  const da = new Date(pa[0], pa[1] - 1, pa[2]);
  const db = new Date(pb[0], pb[1] - 1, pb[2]);
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / 86400000));
}

export function applyStallNudge(input: StallNudgeInput): Prescription {
  const {
    base,
    liftHistory,
    lastRir,
    energyScore,
    isCompound,
    fitnessLevel,
    todayIso,
    stallWeeksThreshold = STALL_WEEKS,
  } = input;

  // Priority guard: never override failure / low_energy / backoff. The
  // nudge only fires on the would-hold + clean + normal-or-high-energy
  // case, exactly as the spec calls out.
  if (base.rationale !== 'hold') return base;
  if (base.cause !== 'rir') return base;

  // Clean = last RIR is at/below target (1 or 2). null is "no signal" —
  // we don't claim "stall" without evidence; let the engine keep holding.
  // (lastRir === 0 is failure and is already filtered by the cause guard
  // above; this check is belt-and-braces against future engine changes.)
  if (lastRir !== 1 && lastRir !== 2) return base;

  // Energy only protects — low energy suppresses the nudge.
  if (energyScore <= 2) return base;

  // Need enough sessions to claim a stall. One session at the current top
  // is just "today's lift"; the run starts at ≥ 2.
  if (!liftHistory || liftHistory.length < 2) return base;

  // Sort oldest-first so the walk-back logic is obvious.
  const sorted = [...liftHistory].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const currentTop = latest.topKg;

  // Walk backward while the prior session also sat at currentTop. Any
  // earlier session that was at a DIFFERENT weight (higher or lower)
  // ends the run — that's the "without an increase" boundary AND it's
  // the "trained in the window" check (we only count sessions present
  // in history, never gaps).
  let earliestAtSameWeight = latest;
  let runLength = 1;
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i].topKg === currentTop) {
      earliestAtSameWeight = sorted[i];
      runLength++;
    } else {
      break;
    }
  }

  // Need ≥ 2 sessions in the run (the spec's "actually trained in that
  // window, not just absent" requirement — a 3-week-old single session
  // does NOT earn a nudge).
  if (runLength < 2) return base;

  // Weeks between the EARLIEST session at currentTop and today. This is
  // "how long the user has been parked here." Using today (not the latest
  // session) means a lifter who holds 80 kg, takes a week off, and comes
  // back to 80 kg still gets the credit for those flat weeks.
  const days = daysBetweenIso(earliestAtSameWeight.date, todayIso);
  const weeks = Math.floor(days / 7);
  if (weeks < stallWeeksThreshold) return base;

  // Bump using the same step + beginner-halving rules as a real
  // progression. Mirrors prescribeLoad's `up` computation deliberately —
  // a stall-earned bump should feel identical to one earned by a clean
  // RIR-3 set, just labelled differently.
  const beginnerScale = fitnessLevel === 'beginner' ? 0.5 : 1;
  const up = (isCompound ? 0.05 : 0.025) * beginnerScale;
  const bumpedKg = roundToPlate(currentTop * (1 + up));

  // If plate rounding collapsed the bump to zero, leave the engine's
  // hold in place. The presenter's reason would say "time to add a
  // little" next to "Same as last" — exactly the kind of contradiction
  // the prompt forbids. Honest behavior: don't claim a nudge that
  // didn't move the bar.
  if (bumpedKg <= currentTop) return base;

  return {
    suggestedWeightKg: bumpedKg,
    deltaPct: up,
    rationale: 'progress',
    cause: 'time_to_progress',
    stallWeeks: weeks,
  };
}

// ── Outcome scoring (used by the prescription_outcome event) ───────────
// Pure functions so the math is unit-tested and identical wherever it runs.

/** Did the user log within one plate (±2.5kg) of the suggestion? */
export function wasFollowed(suggestedKg: number, loggedKg: number): boolean {
  return Math.abs(loggedKg - suggestedKg) <= 2.5;
}

/** Did the set land in the autoregulation sweet spot? Zone is lane-aware:
 *    - strength: 1-3 (hold on a clean target set; back off only on true failure)
 *    - muscle:   0-2 (proximity to failure is the growth driver)
 *    - general:  1-2 (unchanged from the pre-goal engine — pass-through)
 *
 *  Passing `goal` is optional; unknown / undefined → general behaviour, so
 *  the analytics event stays back-compat for callers not yet plumbed. */
export function hitTargetZone(rir: number | null, goal?: Goal): boolean {
  if (rir == null) return false;
  if (goal === 'strength') return rir === 1 || rir === 2 || rir === 3;
  if (goal === 'muscle') return rir === 0 || rir === 1 || rir === 2;
  return rir === 1 || rir === 2;
}
