// Pure presenters that translate the autoregulation engine's structured
// output into UI copy. The engine (src/lib/loadPrescription.ts) already
// decides rationale, cause, and delta — these helpers only turn that
// decision into the workout-screen hero block and the per-exercise lines
// on the finish recap. No math, no schema changes, no new facts.
//
// Why this lives in src/lib (not in the screen file): pure + tested. The
// screen can keep growing; this layer can be exercised without a React
// harness, the same way coachRecap.buildFallbackRecap and coachVoice
// phraseObservation are.

import type { Prescription } from './loadPrescription';

// ── Public types ────────────────────────────────────────────────────────

export type PrescriptionTone = 'progress' | 'backoff' | 'hold' | 'cold';

export interface PrescriptionHero {
  tone: PrescriptionTone;
  /** Suggested load. "85 kg" — empty when there's no suggestion (cold). */
  weightLabel: string;
  /** Signed delta vs last session. "+2.5 kg vs last", "−5 kg vs last",
   *  "Same as last", or "" when cold. Minus uses the U+2212 minus sign so
   *  it visually pairs with "+" at the same width. */
  deltaLabel: string;
  /** Cause-driven one-line reason. Never empty. */
  reason: string;
}

export interface PrescriptionHeroInput {
  /** Engine output for this lift. `undefined` is treated as cold start —
   *  the engine had no last-session weight to read. `stallWeeks` is the
   *  applyStallNudge augmentation and is read only when cause ===
   *  'time_to_progress'. */
  rx: Pick<Prescription, 'suggestedWeightKg' | 'deltaPct' | 'rationale' | 'cause' | 'stallWeeks'> | undefined;
  /** What the engine read as the user's previous session weight. Falls
   *  back to suggestedWeightKg when missing so the delta math doesn't
   *  break (rare mid-state — see workout.tsx's lastWeights race). */
  lastWeightKg?: number;
  /** True when the engine had a real RIR signal on the prior session.
   *  Lets the 'hold' branch distinguish "right zone" from "no signal,
   *  repeating". Defaults to false. */
  hasLastRir?: boolean;
  /** Today's energy score (1–5). Drives the energy-framed wrapper on the
   *  hold and low-energy branches. Defaults to 3 (normal) when missing,
   *  which collapses to the non-energy hold copy. */
  energyScore?: number;
}

// ── Copy ────────────────────────────────────────────────────────────────
//
// The hero on the active workout card used to have three stacked voices:
// this reason line, a separate "Coach:" line (coachLineForPrescription),
// and a micro-line (energy banner). They overlapped, and worst of all
// the reason and the delta could disagree — rationale: 'progress' with a
// plate-capped diff of 0 produced "going up today" right next to "Same
// as last". The merge folds energy framing + the rep directive into the
// SAME sentence the reason owns, and the line is chosen off the ACTUAL
// rounded delta — never off rationale alone.
//
// Plain-language standard: each line is CAUSAL (a reason followed by what
// we're doing about it) and uses words a non-lifter understands. No "reps
// in reserve", "adding load", "in reserve", "RIR", "deload", "mesocycle",
// "block week", or other insider terms. The kg is woven into the sentence
// so the directive ("match", "ease down to", "up to") matches the kg the
// user is staring at — pinned by tests.

const COPY_COLD_START = "First time on this — we'll find your weight as you go.";

const TONE_BY_RATIONALE: Record<Prescription['rationale'], PrescriptionTone> = {
  progress: 'progress',
  backoff: 'backoff',
  hold: 'hold',
  no_history: 'cold',
};

/** kg → "85" or "82.5". Mirrors coachVoice's kg() helper so display is
 *  consistent across surfaces. */
function fmtKg(kg: number): string {
  if (!Number.isFinite(kg)) return '';
  const r = Math.round(kg * 10) / 10;
  const s = r.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

type EnergyBand = 'low' | 'normal' | 'high';
function bandFor(energyScore: number | undefined): EnergyBand {
  if (typeof energyScore !== 'number') return 'normal';
  if (energyScore <= 2) return 'low';
  if (energyScore >= 4) return 'high';
  return 'normal';
}

interface ReasonInput {
  rationale: Prescription['rationale'];
  cause: Prescription['cause'];
  hasLastRir: boolean;
  /** Display kg with "kg" suffix — e.g. "82.5 kg" — so the sentence can
   *  weave it in directly without re-formatting at every callsite. */
  weightLabel: string;
  /** Display kg the user was holding before this prescription. Used only
   *  by the time_to_progress branch so the line names the OLD weight
   *  ("you've held 80 kg") rather than the bumped one. Empty when the
   *  caller has no lastWeightKg (cold start). */
  lastWeightLabel: string;
  /** Weeks the lift sat at the same top weight before the stall nudge
   *  fired. Populated only when cause === 'time_to_progress'. */
  stallWeeks?: number;
  /** ROUNDED delta (suggested − last) in kg. The reason is chosen off
   *  THIS, not rx.rationale, so "Same as last" can never appear next to
   *  a "going up" sentence. A plate-capped progression (diff rounds to 0)
   *  switches to the rep-progression line instead. */
  diff: number;
  band: EnergyBand;
}

function reasonFor(input: ReasonInput): string {
  const { rationale, cause, hasLastRir, weightLabel, lastWeightLabel, stallWeeks, diff, band } = input;

  // 1. Cold start — no history yet. Engine has no decision to dress up.
  if (rationale === 'no_history') return COPY_COLD_START;

  // 2. Failure backoff — the strongest engine signal. Even on a low/high
  //    energy day, "you maxed out, stay here" is the honest read.
  if (cause === 'failure') {
    return `You maxed out at this weight last time — staying at ${weightLabel} to nail it.`;
  }

  // 3. Low energy — tone-aware so the words match what actually happened
  //    to the number. Backoff says "ease down to {kg}", hold says
  //    "hold {kg}". Saying "we're protecting you" the same way for both
  //    disconnects the sentence from the kg the user is looking at.
  if (cause === 'low_energy') {
    if (rationale === 'backoff') {
      return `Energy's been low — ease down to ${weightLabel} today.`;
    }
    return `Energy's been low — hold ${weightLabel}, don't grind.`;
  }

  // 4. Time-to-progress nudge (applyStallNudge fired). The line names the
  //    OLD weight + how long the user has been parked at it. The hero's
  //    suggested kg is the BUMPED weight (the suggestion the user is
  //    about to act on), so this branch is the only place we deliberately
  //    weave in lastWeightLabel instead of weightLabel — that's what
  //    keeps the sentence honest with what the user is feeling ("I've
  //    been doing this weight forever"). Falls through to the regular
  //    progress copy when the augment didn't populate stallWeeks (legacy
  //    callers) or didn't supply lastWeightLabel.
  if (cause === 'time_to_progress' && lastWeightLabel && stallWeeks) {
    return `You've held ${lastWeightLabel} for ${stallWeeks} weeks — time to add a little. Earn it.`;
  }

  // 5. Progress — keyed off the ACTUAL delta, not rationale. The
  //    plate-capped case (engine wanted to bump but the suggested weight
  //    rounded to the same plate) was the source of the "going up" /
  //    "Same as last" contradiction; it now pushes a rep instead.
  if (rationale === 'progress') {
    if (diff > 0) {
      return `You had more in you last time — up to ${weightLabel}.`;
    }
    return `You had more last time — match ${weightLabel} and earn an extra rep.`;
  }

  // 5. Backoff with neither failure nor low_energy — engine quirk, not
  //    a real path today. Fall through to a generic "easing down" so
  //    we're never silent, but never claim a cause that isn't there.
  if (rationale === 'backoff') {
    return `Easing down to ${weightLabel} — clean reps over heavy ones.`;
  }

  // 6. Hold — energy band modulates the directive. High energy day on
  //    a hold means push reps (you've got the gas without bumping load);
  //    no-RIR-signal means we're repeating to read it; the normal case
  //    is the reassurance line.
  if (band === 'high') {
    return `Energy's good — match ${weightLabel} and chase an extra rep.`;
  }
  if (!hasLastRir) {
    return `No read on last time — repeat ${weightLabel} to feel it out.`;
  }
  return `That felt right last time — match ${weightLabel}, keep the reps clean.`;
}

// ── Hero block (workout active-set screen) ──────────────────────────────

export function buildPrescriptionHero(input: PrescriptionHeroInput): PrescriptionHero {
  const { rx, lastWeightKg, hasLastRir, energyScore } = input;
  if (!rx || rx.rationale === 'no_history') {
    return { tone: 'cold', weightLabel: '', deltaLabel: '', reason: COPY_COLD_START };
  }
  const last = typeof lastWeightKg === 'number' && lastWeightKg > 0
    ? lastWeightKg
    : rx.suggestedWeightKg;
  const diff = Math.round((rx.suggestedWeightKg - last) * 10) / 10;
  let deltaLabel: string;
  if (diff === 0) {
    deltaLabel = 'Same as last';
  } else if (diff > 0) {
    deltaLabel = `+${fmtKg(diff)} kg vs last`;
  } else {
    // U+2212 minus — visually balanced with "+", not a hyphen.
    deltaLabel = `−${fmtKg(Math.abs(diff))} kg vs last`;
  }
  const weightLabel = `${fmtKg(rx.suggestedWeightKg)} kg`;
  // lastWeightLabel is the kg the user was holding pre-prescription —
  // used by the time_to_progress reason line. Empty when the caller had
  // no last weight (rare; presenter's cold-start branch above already
  // handles no_history).
  const lastWeightLabel = typeof lastWeightKg === 'number' && lastWeightKg > 0
    ? `${fmtKg(lastWeightKg)} kg`
    : '';
  return {
    tone: TONE_BY_RATIONALE[rx.rationale],
    weightLabel,
    deltaLabel,
    reason: reasonFor({
      rationale: rx.rationale,
      cause: rx.cause,
      hasLastRir: hasLastRir ?? false,
      weightLabel,
      lastWeightLabel,
      stallWeeks: rx.stallWeeks,
      // Diff is passed pre-rounded so the reason picker and the delta
      // label agree on "did the weight move." Without this, a sub-plate
      // bump (e.g. +0.4 kg) could leave the reason saying "up to {kg}"
      // while the delta label rendered "Same as last."
      diff,
      band: bandFor(energyScore),
    }),
  };
}

