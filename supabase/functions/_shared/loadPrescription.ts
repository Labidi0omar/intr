// Deno-compatible mirror of src/lib/loadPrescription.ts + the compound
// classifier from src/lib/planGeneration.ts. Edge functions can't import
// React Native code, so the algorithm lives in two places. Keep them in sync
// — when one changes, change the other. The unit tests in
// src/lib/loadPrescription.test.ts are the source of truth for behavior.

// ── Compound classification ────────────────────────────────────────────

const ISOLATION_KEYWORDS = [
  ' raise', ' curl', ' extension', ' fly', ' pushdown', ' kickback',
  ' pullover', ' shrug', ' crunch',
];

const HEAVY_COMPOUND_KEYWORDS = [
  'squat', 'deadlift', 'bench press', 'overhead press', 'barbell row',
  't-bar row', 'romanian deadlift', 'pull-up', 'pullup', 'chin-up', 'chinup',
  'dip', 'clean', 'snatch',
];

const COMPOUND_KEYWORDS = [
  'press', 'row', 'pulldown', 'lunge', 'hip thrust', 'glute bridge',
  'split squat', 'leg press', 'push-up', 'pushup',
];

function classifyCompoundness(name: string): number {
  const n = ' ' + name.toLowerCase() + ' ';
  for (const k of ISOLATION_KEYWORDS) if (n.includes(k)) return 2;
  for (const k of HEAVY_COMPOUND_KEYWORDS) if (n.includes(k)) return 10;
  for (const k of COMPOUND_KEYWORDS) if (n.includes(k)) return 7;
  return 5;
}

export function isCompoundName(name: string): boolean {
  return classifyCompoundness(name) >= 7;
}

// ── Prescription ───────────────────────────────────────────────────────
// Mirror of the RN-side loadPrescription: goal-aware RIR ladder, calibration
// damper, and universal top-of-band gate. Keep in sync with the RN file —
// loadPrescription.parity.test.ts iterates the full input grid across both
// implementations and will fail loudly on any divergence.

export type Goal = 'strength' | 'muscle' | 'general';

export interface PrescriptionInput {
  lastWeightKg: number;
  lastRir: number | null;
  energyScore: number;
  isCompound: boolean;
  fitnessLevel?: 'beginner' | 'intermediate' | 'advanced';
  goal?: Goal;
  lastReps?: number | null;
  topReps?: number | null;
  sessionCountForLift?: number;
}

export interface Prescription {
  suggestedWeightKg: number;
  deltaPct: number;
  rationale: 'progress' | 'hold' | 'backoff' | 'no_history';
}

export const CALIBRATION_SESSIONS = 3;

function roundToPlate(kg: number, step = 2.5): number {
  return Math.max(step, Math.round(kg / step) * step);
}

export function prescribeLoad(input: PrescriptionInput): Prescription {
  const {
    lastWeightKg, lastRir, energyScore, isCompound, fitnessLevel,
    goal, lastReps, topReps, sessionCountForLift,
  } = input;

  if (!lastWeightKg || lastWeightKg <= 0) {
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'no_history' };
  }
  if (lastRir === null) {
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'hold' };
  }

  const inCalibrationWindow =
    fitnessLevel === 'beginner' ||
    (typeof sessionCountForLift === 'number' && sessionCountForLift < CALIBRATION_SESSIONS);

  const stepScale = inCalibrationWindow ? 0.5 : 1;
  const up = (isCompound ? 0.05 : 0.025) * stepScale;

  const lane: Goal =
    goal === 'strength' || goal === 'muscle' || goal === 'general' ? goal : 'general';

  let deltaPct: number;
  let rationale: Prescription['rationale'];

  if (lane === 'strength') {
    if (lastRir >= 3)                       { deltaPct = up;    rationale = 'progress'; }
    else if (lastRir === 2 || lastRir === 1){ deltaPct = 0;     rationale = 'hold'; }
    else                                    { deltaPct = -0.05; rationale = 'backoff'; }
  } else {
    if (lastRir >= 3)      { deltaPct = up;      rationale = 'progress'; }
    else if (lastRir === 2){ deltaPct = up / 2;  rationale = 'progress'; }
    else if (lastRir === 1){ deltaPct = 0;       rationale = 'hold'; }
    else                   { deltaPct = -0.05;   rationale = 'backoff'; }
  }

  if (inCalibrationWindow && lastRir === 0) {
    deltaPct = 0;
    rationale = 'hold';
  }

  const gateActive =
    typeof lastReps === 'number' && Number.isFinite(lastReps) &&
    typeof topReps === 'number' && Number.isFinite(topReps) && topReps > 0;
  if (gateActive && rationale === 'progress' && (lastReps as number) < (topReps as number)) {
    deltaPct = 0;
    rationale = 'hold';
  }

  if (energyScore <= 2 && deltaPct > 0) {
    deltaPct = 0;
    rationale = 'hold';
  } else if (energyScore <= 2 && rationale === 'hold') {
    deltaPct = -0.05;
    rationale = 'backoff';
  }

  return {
    suggestedWeightKg: roundToPlate(lastWeightKg * (1 + deltaPct)),
    deltaPct,
    rationale,
  };
}
