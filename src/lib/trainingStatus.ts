// Training Status — a trend-based, plain-English read of how the user is
// actually holding up over the last ~2–3 weeks.
//
// THIS IS NOT THE DELETED readiness.ts. Readiness was a same-day 0–100
// score with an energy weight that could read "you trained today, so you're
// tired." Training Status is the opposite by construction:
//
//   • It reads only the TREND across a trailing window — per-lift strength
//     deltas, adherence, and two repeated fatigue signals. A single hard or
//     low-energy day never moves it; the signals all require repetition.
//   • It NEVER penalizes "trained today." There is no same-day input. The
//     caller feeds trailing aggregates; this module can't see today in
//     isolation, so it can't punish it.
//
// Pure & deterministic: no React, no Supabase, no clock. Same inputs → same
// output. Never throws — a new user with no signal returns 'unknown'.
//
// Output is one of three live states plus 'unknown':
//   🟢 recovering_well — lifts progressing/stable, adherence fine, effort normal.
//   🟡 holding_steady  — progress slowing, more missed targets, or fatigue rising.
//   🔴 backing_off     — multiple key lifts declining and/or repeated low
//                        energy + RIR misses.
//
// The raw inputs are echoed back on the result so the deload logic
// (decideDeloadOffer + the dashboard wiring) can act on the same numbers
// without recomputing them.

export type TrainingStatusState =
  | 'recovering_well'
  | 'holding_steady'
  | 'backing_off'
  | 'unknown';

export interface TrainingStatusInputs {
  /** Per-key-lift signed weight delta over the trailing window
   *  (recentMax − priorMax), one entry per lift with numeric logs in BOTH
   *  sub-windows. Sourced from computeStrengthTrendFromLogs().perLift. Empty
   *  when nothing overlapped both windows (new user / no numeric overlap). */
  liftDeltas: readonly { name: string; deltaKg: number }[];
  /** Completed vs planned training sessions over the window. plannedSessions
   *  === 0 means "no plan data" — adherence is treated as neutral, never as a
   *  penalty (so a brand-new account isn't marked 🔴 for an empty schedule). */
  completedSessions: number;
  plannedSessions: number;
  /** Lifetime count of completed (non-recovery) sessions — a MONOTONIC figure
   *  used ONLY by the calibration gate, so the recovery read, once unlocked,
   *  never re-locks during a thin recent fortnight (deload / travel / illness).
   *  Optional: when omitted, the gate falls back to completedSessions (the
   *  trailing-window count) for back-compat. Never feeds the score — scoring
   *  always reads the recent window via completedSessions. */
  lifetimeCompletedSessions?: number;
  /** Sessions in the window whose pre-workout energy_score was LOW (≤ 2), and
   *  how many recorded ANY score. A single low day (lowEnergySessions === 1)
   *  is never enough to back off — the fatigue read requires repetition. */
  lowEnergySessions: number;
  ratedEnergySessions: number;
  /** Rated sets (reps_in_reserve != null) in the window, and how many landed
   *  OUTSIDE the 1–2 RIR target zone — RIR 0 (overshot to failure) or RIR ≥ 3
   *  (left too much in the tank). A high miss rate is the second fatigue/drift
   *  signal. */
  ratedSets: number;
  rirMissSets: number;
}

export interface TrainingStatusResult {
  state: TrainingStatusState;
  /** Recovery score, 0–100, as a single 50/50 read: performance half
   *  (strength trend + adherence) plus recovery half (full marks minus
   *  repeated-fatigue penalties). `null` — and ONLY null — when there is no
   *  trend window yet (new user); the UI shows "Building", never a fake 50.
   *  The `state` is derived from this number's band, so the two can never
   *  contradict each other. */
  score: number | null;
  /** One short, plain-English sentence. References only measured inputs
   *  (top mover, energy, adherence) — never invented physiology. Never empty. */
  reason: string;
  /** Echo of the inputs so the deload logic reads the same numbers. */
  inputs: TrainingStatusInputs;
  /** Derived counts, exposed for the deload decision + tests. */
  liftsProgressing: number;
  liftsDeclining: number;
  topMover: { name: string; deltaKg: number } | null;
}

// ── Tunables ────────────────────────────────────────────────────────────
// All weights/cutoffs live here so the 50/50 score is easy to tune and the
// tests pin them. Two design rules baked in:
//   1. Repetition gate: a SINGLE low day or a SINGLE miss barely moves the
//      score — only repetition bites (the first low day is "free"; a few
//      misses sit under the tolerance).
//   2. Strength-dominant but adherence-contributing performance half; the
//      recovery half is the earlier-warning side.

// Performance half (0–PERF_HALF_MAX), strength-dominant.
const PERF_HALF_MAX = 50;
/** Strength sub-range of the performance half (strength-dominant). */
const STRENGTH_MAX = 35;
/** Adherence sub-range of the performance half (contributes, doesn't dominate). */
const ADHERENCE_MAX = 15; // STRENGTH_MAX + ADHERENCE_MAX === PERF_HALF_MAX
/** Flat/no-signal strength sits at the MIDDLE of its range (neither reward
 *  nor punish a trend we can't see). */
const STRENGTH_NEUTRAL = STRENGTH_MAX / 2;
/** Lifts needed before the strength read is at full confidence. With fewer
 *  lifts the sub-score is pulled toward neutral, so ONE big PR can't spike
 *  the whole score — it's a trailing trend, not a single number. */
const STRENGTH_CONFIDENCE_LIFTS = 3;

// Recovery half (0–RECOVERY_HALF_MAX): starts full, fatigue subtracts.
const RECOVERY_HALF_MAX = 50;
/** The first low-energy session is free — one bad day is not a trend. */
const LOW_ENERGY_FREE = 1;
/** Penalty per repeated low-energy session beyond the free one. */
const LOW_ENERGY_PENALTY_PER = 16;
/** Cap on the low-energy penalty so it can't single-handedly zero recovery. */
const LOW_ENERGY_PENALTY_MAX = 34;
/** RIR-miss rate below which effort costs nothing — a few misses are normal. */
const RIR_MISS_TOLERANCE = 0.35;
/** Penalty per unit of miss-rate ABOVE the tolerance. */
const RIR_MISS_PENALTY_SCALE = 55;
/** Cap on the RIR-miss penalty. */
const RIR_MISS_PENALTY_MAX = 28;
/** Enough rated sets for the RIR-miss rate to mean anything. Below this the
 *  effort signal is treated as "no signal", not as a problem. */
const MIN_RATED_SETS = 4;

/**
 * Minimum recent completed sessions before the recovery half may claim full
 * marks. The recovery half is a fatigue-SUBTRACTION model — an idle account
 * has no fatigue to subtract, so absent this gate a user who hasn't trained
 * at all reads as maximally recovered, and the state floats to 🟢 recovering_well.
 *
 * Below this floor, the recovery half is CAPPED at the neutral middle
 * (RECOVERY_HALF_MAX / 2) — the read is "no evidence" rather than "well
 * recovered." Combined with the neutral-ish performance half a detrained
 * account lands in 🟡 holding_steady, never 🟢. That's the design goal:
 * absence of training ≠ green (Part 1 of the strength-cap-and-deload PR).
 *
 * It is NOT a penalty — no extra points are subtracted, so a legit deload /
 * travel / illness week never falls into 🔴 backing_off.
 */
const RECOVERY_FULL_MARKS_TRAINING_FLOOR = 2;

// Band → state. Single source of truth: the state is ALWAYS the band of the
// score, so the number and the label can never disagree.
/** score < this → 🔴 backing_off. */
const BACKING_OFF_CEIL = 40;
/** score ≤ this (and ≥ BACKING_OFF_CEIL) → 🟡 holding_steady; above → 🟢. */
const HOLDING_CEIL = 70;

// ── Reason-driver thresholds (copy only; never affect the score) ──────────
/** Repeated low-energy sessions worth calling out by name in the reason. */
const LOW_ENERGY_REPEATED = 2;
/** Miss rate worth calling out as "missing the target zone" in the reason. */
const RIR_MISS_HIGH = 0.5;
/** Declining lifts worth calling out as "N lifts sliding" in the reason. */
const LIFTS_SLIDING_CALLOUT = 2;

function clampInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Derive the state from the score band — the ONLY place state is decided. */
function bandState(score: number): Exclude<TrainingStatusState, 'unknown'> {
  if (score < BACKING_OFF_CEIL) return 'backing_off';
  if (score <= HOLDING_CEIL) return 'holding_steady';
  return 'recovering_well';
}

/**
 * Compute the trend-based Training Status with a 0–100 recovery score and a
 * band-derived state. Pure; never throws.
 */
export function computeTrainingStatus(inputsRaw: TrainingStatusInputs): TrainingStatusResult {
  // Defensive normalization — the caller assembles these from network reads.
  const liftDeltas = Array.isArray(inputsRaw.liftDeltas) ? inputsRaw.liftDeltas : [];
  const completedSessions = clampInt(inputsRaw.completedSessions);
  const plannedSessions = clampInt(inputsRaw.plannedSessions);
  const lowEnergySessions = clampInt(inputsRaw.lowEnergySessions);
  const ratedEnergySessions = clampInt(inputsRaw.ratedEnergySessions);
  const ratedSets = clampInt(inputsRaw.ratedSets);
  const rirMissSets = clampInt(inputsRaw.rirMissSets);

  const inputs: TrainingStatusInputs = {
    liftDeltas,
    completedSessions,
    plannedSessions,
    // Echo the sticky lifetime count (normalized) so computeCalibration reads
    // the SAME gate input whether called on raw inputs or on this echo.
    lifetimeCompletedSessions:
      inputsRaw.lifetimeCompletedSessions != null
        ? clampInt(inputsRaw.lifetimeCompletedSessions)
        : undefined,
    lowEnergySessions,
    ratedEnergySessions,
    ratedSets,
    rirMissSets,
  };

  // Derived signals. validLifts only counts entries with a finite delta, so
  // garbage rows can't inflate the trend denominator.
  let liftsProgressing = 0;
  let liftsDeclining = 0;
  let validLifts = 0;
  let topMover: { name: string; deltaKg: number } | null = null;
  for (const l of liftDeltas) {
    if (!l || typeof l.deltaKg !== 'number' || !Number.isFinite(l.deltaKg)) continue;
    validLifts++;
    if (l.deltaKg > 0) liftsProgressing++;
    else if (l.deltaKg < 0) liftsDeclining++;
    if (!topMover || l.deltaKg > topMover.deltaKg) topMover = { name: l.name, deltaKg: l.deltaKg };
  }

  const hasStrengthSignal = validLifts > 0;
  const hasEffortSignal = ratedSets >= MIN_RATED_SETS;
  const rirMissRate = ratedSets > 0 ? rirMissSets / ratedSets : 0;
  const lowEnergyRepeated = lowEnergySessions >= LOW_ENERGY_REPEATED;
  const rirMissesHigh = hasEffortSignal && rirMissRate >= RIR_MISS_HIGH;
  const adherenceRatio = plannedSessions > 0 ? completedSessions / plannedSessions : null;

  // ── unknown — genuinely no trend window yet ─────────────────────────────
  // No strength comparison AND no effort AND no energy data: there's nothing
  // to score. Return score:null so the UI shows "Building", never a fake 50.
  // The gate is factored into hasTrainingSignal() so the calibration UI can
  // count toward the EXACT same condition — the two can never diverge.
  if (!hasTrainingSignal(inputs)) {
    return {
      state: 'unknown',
      score: null,
      reason: 'Building your baseline — keep logging your sessions.',
      inputs,
      liftsProgressing,
      liftsDeclining,
      topMover,
    };
  }

  // ── Performance half (0–50): strength trend + adherence ─────────────────
  // net ∈ [-1, 1]: all lifts up → +1 (top of range), balanced/flat → 0
  // (middle), all down → -1 (bottom). Confidence pulls a thin sample toward
  // neutral so a single PR can't max it.
  const net = validLifts > 0 ? (liftsProgressing - liftsDeclining) / validLifts : 0;
  const rawStrength = STRENGTH_MAX * (net + 1) / 2;
  const confidence = Math.min(1, validLifts / STRENGTH_CONFIDENCE_LIFTS);
  const strengthSub = hasStrengthSignal
    ? STRENGTH_NEUTRAL + (rawStrength - STRENGTH_NEUTRAL) * confidence
    : STRENGTH_NEUTRAL;
  // No plan data → full adherence credit (neutral, never a penalty).
  const adherenceSub = adherenceRatio == null
    ? ADHERENCE_MAX
    : ADHERENCE_MAX * clamp(adherenceRatio, 0, 1);
  const performanceHalf = clamp(strengthSub + adherenceSub, 0, PERF_HALF_MAX);

  // ── Recovery half (0–50): full marks minus repeated-fatigue penalties ───
  // The first low day is free; each repeat costs. A miss rate under the
  // tolerance costs nothing; only the excess is penalized.
  //
  // "Absence of training ≠ green" gate (see RECOVERY_FULL_MARKS_TRAINING_FLOOR):
  // an idle account has no fatigue signals to subtract, so without a cap it
  // would claim full recovery marks and float to 🟢. When recent completed
  // sessions are below the floor we START from the neutral middle instead of
  // RECOVERY_HALF_MAX — that's a "no evidence, no verdict" ceiling, NOT an
  // added penalty, so a legit deload / travel / illness week can still show
  // as 🟡 holding_steady rather than getting slammed into 🔴 backing_off.
  const isTrainingRecently = completedSessions >= RECOVERY_FULL_MARKS_TRAINING_FLOOR;
  const recoveryStart = isTrainingRecently ? RECOVERY_HALF_MAX : RECOVERY_HALF_MAX / 2;
  const lowEnergyPenalty = Math.min(
    LOW_ENERGY_PENALTY_MAX,
    Math.max(0, lowEnergySessions - LOW_ENERGY_FREE) * LOW_ENERGY_PENALTY_PER,
  );
  const rirMissPenalty = hasEffortSignal
    ? Math.min(RIR_MISS_PENALTY_MAX, RIR_MISS_PENALTY_SCALE * Math.max(0, rirMissRate - RIR_MISS_TOLERANCE))
    : 0;
  const recoveryHalf = clamp(recoveryStart - lowEnergyPenalty - rirMissPenalty, 0, RECOVERY_HALF_MAX);

  const score = Math.round(clamp(performanceHalf + recoveryHalf, 0, 100));
  const state = bandState(score);

  // ── Reason — a RECOVERY read, not a strength flex ───────────────────────
  // The card is labelled RECOVERY, so the copy explains how recovered the
  // user is and how the score got there, in recovery language. The score is
  // 50/50 (training + recovery), and the sentence mirrors that: a training
  // clause AND a recovery clause, then a recovery-framed verdict. Strength is
  // only ever a contributing clause ("lifts are trending up"), never the
  // headline. Measured inputs only — lift trend, adherence, repeated low
  // energy, RIR misses. No invented physiology (no "nervous system" etc.).

  // Training side (the performance half), most-actionable driver first.
  const trainingClause = (() => {
    if (adherenceRatio != null && adherenceRatio < 0.5) {
      return `${completedSessions} of ${plannedSessions} sessions in`;
    }
    if (liftsDeclining >= LIFTS_SLIDING_CALLOUT) return `${liftsDeclining} key lifts are sliding`;
    if (liftsProgressing > 0 && liftsDeclining === 0) return 'lifts are trending up';
    if (liftsDeclining > 0) return 'progress is leveling';
    if (hasStrengthSignal) return 'lifts are holding';
    return "you're showing up";
  })();

  // Recovery side (the recovery half). Honest even on a high score: if energy
  // dipped repeatedly we say so rather than claim it's steady. When the user
  // has been detrained (recovery-half cap fired), don't claim "energy's
  // steady" — there are no recent sessions to read energy from.
  const recoveryClause = (() => {
    if (lowEnergyRepeated && rirMissesHigh) return `energy's down ${lowEnergySessions} sessions and targets are slipping`;
    if (lowEnergyRepeated) return `energy's dipped ${lowEnergySessions} sessions`;
    if (rirMissesHigh) return "you're missing the target zone";
    if (!isTrainingRecently) return "no recent sessions to read";
    return "energy's steady";
  })();

  let reason: string;
  if (state === 'recovering_well') {
    // Half training, half recovery — both reading well.
    reason = `${cap(trainingClause)} and ${recoveryClause} — well recovered.`;
  } else if (state === 'holding_steady') {
    reason = `${cap(trainingClause)} and ${recoveryClause} — hold steady.`;
  } else {
    // backing_off — lead with the recovery concern; this is a recovery card.
    const concern = lowEnergyRepeated || rirMissesHigh
      ? recoveryClause
      : liftsDeclining >= LIFTS_SLIDING_CALLOUT
        ? `${liftsDeclining} key lifts are sliding`
        : 'the trend is slipping';
    reason = `${cap(concern)} — back off and recover.`;
  }

  return { state, score, reason, inputs, liftsProgressing, liftsDeclining, topMover };
}

/** Capitalize the first letter (for sentence-leading measured phrases). */
function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ── Deload integration (pure decision + copy) ─────────────────────────────
//
// Every offer is tap-to-accept; this module only DECIDES whether to surface
// the option. The dashboard owns the tap + the plan write.

export type DeloadOffer = 'early' | 'skip' | null;

/** Minimum real completed sessions in the trailing block-window before the
 *  deload offer surfaces. A deload only makes sense once the user has
 *  actually accumulated training fatigue — an idle account rolling into
 *  its calendar week 4 must NOT be offered a "skip" (or "early") because
 *  it has nothing to deload from. Same rationale as Part 1's recovery cap. */
export const DELOAD_TRAINING_FLOOR = 3;

export interface DeloadDecisionInputs {
  state: TrainingStatusState;
  /** In-block week (1–4) of the active week. null when unknown — no offer. */
  blockWeek: number | null;
  /** Whether the active row is already a deload (PlanDay.deload). Guards the
   *  early offer so we never offer to "pull forward" a deload that's already
   *  here. */
  activeIsDeload: boolean;
  /** Real completed non-recovery sessions in the trailing block window
   *  (typically the same figure as TrainingStatusInputs.completedSessions).
   *  Below DELOAD_TRAINING_FLOOR the offer is suppressed regardless of
   *  state — "no training in the block ⇒ no deload offer, full stop."
   *  Optional so legacy callers don't crash; when omitted the offer skips
   *  the gate (back-compat behavior). New callers MUST wire this. */
  recentCompletedSessions?: number;
  /** Count of lifts with positive weight delta in the recent window
   *  (from TrainingStatusResult.liftsProgressing). Optional. Currently used
   *  only for defensive reason-copy in tests; the primary gate is
   *  recentCompletedSessions. Included on the interface so future
   *  refinements ("no offer without any lift moving") don't require another
   *  API change. */
  liftsProgressing?: number;
}

/**
 * Decide which (if any) tap-to-accept deload action to surface.
 *
 *   'skip'  — entering a SCHEDULED week-4 deload while strongly 🟢. Default is
 *             always to keep the deload; this only OFFERS skipping.
 *   'early' — 🔴 (sustained back-off) before week 4, with no deload active
 *             yet — offer to pull the deload forward to now.
 *   null    — nothing to offer.
 *
 * NEW GATE (Part 2): the block-week counter advances on the CALENDAR, so
 * an idle account rolling into "week 4" with no training will be offered a
 * skip against a deload that never earned itself. The
 * recentCompletedSessions gate ensures we only surface either offer when
 * the user actually trained during the block.
 *
 * Pure. Never auto-acts.
 */
export function decideDeloadOffer(input: DeloadDecisionInputs): DeloadOffer {
  const { state, blockWeek, activeIsDeload, recentCompletedSessions } = input;
  if (blockWeek == null || blockWeek < 1 || blockWeek > 4) return null;

  // No training in the block → no offer, full stop. Wired callers (home.tsx)
  // must pass this; legacy callers that don't get the pre-fix behavior.
  if (recentCompletedSessions != null && recentCompletedSessions < DELOAD_TRAINING_FLOOR) {
    return null;
  }

  // Even when the training floor is met, a detrained 'unknown' state (no
  // real trend to read) means we don't know what to offer. The block week
  // could be a calendar artefact; keep the card quiet.
  if (state === 'unknown') return null;

  // Skip is only ever offered when the schedule has actually put the user
  // INTO the deload week and the trend is strongly positive.
  if (blockWeek === 4 && activeIsDeload) {
    return state === 'recovering_well' ? 'skip' : null;
  }

  // Pull-forward: sustained back-off before the deload week, not already
  // deloading.
  if (!activeIsDeload && state === 'backing_off' && blockWeek >= 1 && blockWeek <= 3) {
    return 'early';
  }

  return null;
}

/**
 * The "explain" copy — a short sentence noting a scheduled deload is near, so
 * the Training Status card can reference it ("…a deload lands in N days").
 * Returns null when there's no upcoming deload to mention.
 */
export function deloadProximityNote(deloadInDays: number | null | undefined): string | null {
  if (deloadInDays == null || !Number.isFinite(deloadInDays) || deloadInDays <= 0) return null;
  return `A deload lands in ${deloadInDays} day${deloadInDays === 1 ? '' : 's'}.`;
}

// ── Calibration unlock (the "Building" → live-gauge handoff) ───────────────
//
// THE single honesty contract for the calibration UI: the displayed
// "X sessions until your recovery read unlocks" countdown MUST finish at the
// exact moment computeTrainingStatus stops returning 'unknown' — no sooner
// (a countdown that hits zero while the gauge still says "Building" is a lie),
// no later (a gauge that appears while the card still counts down is a lie).
//
// We guarantee that by deriving BOTH from one predicate, hasTrainingSignal().
// The 'unknown' early-return above is `!hasTrainingSignal(inputs)`; the
// calibration `unlocked` below is `hasTrainingSignal(inputs)`. They are the
// same boolean by construction.
//
// The threshold: a single logged session is technically "a signal", but a
// one-session read is noise, not a trend — so we hold the read back until
// there's about a week of training behind it (CALIBRATION_SESSIONS_NEEDED
// completed sessions).
//
// Calibration is a ONE-TIME onboarding gate, not a recurring one. The gate
// reads lifetimeCompletedSessions — a MONOTONIC count threaded in by home.tsx
// (and backed by a sticky AsyncStorage flag) — so an established user who logs
// a thin recent fortnight (deload / travel / illness) never reverts to
// "Calibrating". For a brand-new user the lifetime count IS their total, so
// the card still counts down 3 → 2 → 1 on the way in. When the caller omits
// the lifetime figure we fall back to the recent-window completedSessions
// (back-compat for tests / older callers). Scoring is untouched — it always
// reads the recent window; only the calibration-vs-live decision is sticky.

/** Completed sessions that must be logged before the recovery read comes
 *  online — roughly a week of training. The countdown ("2 sessions to go")
 *  and the engine's unknown→live transition both key off this number. */
export const CALIBRATION_SESSIONS_NEEDED = 3;

/** The count the calibration gate reads: the sticky lifetime completed-session
 *  count when the caller provides it, else the recent-window completedSessions
 *  (back-compat). The SINGLE source both the gate and the countdown derive
 *  from, so they can never diverge. */
function calibrationCount(inputs: TrainingStatusInputs): number {
  return inputs.lifetimeCompletedSessions != null
    ? clampInt(inputs.lifetimeCompletedSessions)
    : clampInt(inputs.completedSessions);
}

/**
 * The exact "is there enough logged training to read yet?" predicate.
 * computeTrainingStatus returns 'unknown' (score: null) iff this is false, and
 * computeCalibration().unlocked is exactly this — the two can never diverge.
 * Gated on a monotonic lifetime session count (see calibrationCount). Pure;
 * never throws.
 */
export function hasTrainingSignal(inputsRaw: TrainingStatusInputs): boolean {
  return calibrationCount(inputsRaw) >= CALIBRATION_SESSIONS_NEEDED;
}

export interface CalibrationProgress {
  /** True iff computeTrainingStatus would NOT return 'unknown' — the card
   *  flips to the live gauge on exactly this transition. */
  unlocked: boolean;
  /** Completed sessions logged so far toward the unlock (capped at target). */
  sessionsLogged: number;
  /** The target — CALIBRATION_SESSIONS_NEEDED. */
  sessionsNeeded: number;
  /** Sessions still to log before the read unlocks; 0 once unlocked. */
  remaining: number;
}

/**
 * Progress toward the recovery-read unlock, for the calibration card that
 * replaces the bare "Building" empty state. Reads the SAME gate input the
 * engine scores (calibrationCount), so `unlocked` flips in lockstep with the
 * engine leaving 'unknown'. `remaining` counts down real completed sessions
 * (3 → 2 → 1 → unlocked) on the way in; once the sticky lifetime count is past
 * the threshold it stays unlocked. Pure; never throws.
 */
export function computeCalibration(inputsRaw: TrainingStatusInputs): CalibrationProgress {
  const unlocked = hasTrainingSignal(inputsRaw);
  const sessionsNeeded = CALIBRATION_SESSIONS_NEEDED;
  const completed = calibrationCount(inputsRaw);
  const sessionsLogged = Math.min(sessionsNeeded, completed);
  const remaining = Math.max(0, sessionsNeeded - sessionsLogged);
  return { unlocked, sessionsLogged, sessionsNeeded, remaining };
}
