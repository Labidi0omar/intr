// Conservative starting-strength seed for the FIRST session of a known
// compound. Pure, deterministic, no IO. Returns kg rounded down to a 2.5 kg
// plate so the user always finds the set easy on attempt 1 — the wrong
// direction to err is "too heavy and unsafe", so we always err light.
//
// This exists to kill the blank-weight box on session 1: when the user has
// no logged history (prescribeLoad returns 'no_history'), the workout screen
// uses this seed as the input pre-fill so they tap once instead of guessing.
// It is NOT a prescription — the UI labels it as a starting guess, and the
// real autoregulator takes over from session 2 onward once a RIR exists.
//
// Returns null whenever we can't honestly produce a number:
//   • bodyweight is unknown (user skipped → calibration entry, no fake seed)
//   • the lift isn't a recognised compound (isolations live in calibration)
//   • inputs are non-finite / out of range
//
// The ratios come from the well-trodden untrained / novice strength standards
// (Lon Kilgore / Greg Nuckols style). The base layer is the male beginner
// 8–12 rep working weight; the level multiplier scales for novice→advanced,
// and the sex multiplier biases for female lifters. 'unspecified' uses the
// female multiplier deliberately — we'd rather under-seed than over-seed
// someone we don't have a sex for.

import type { FitnessLevel } from './planGeneration';

export type Sex = 'male' | 'female' | 'unspecified';

export interface StartingLoadInput {
  level: FitnessLevel;
  /** Bodyweight in kg. null/undefined or out of plausible range → null seed. */
  bodyweightKg: number | null | undefined;
  /** null/undefined treated identically to 'unspecified' (conservative). */
  sex: Sex | null | undefined;
  /** Exercise display name from the catalog, e.g. "Barbell Bench Press". */
  liftName: string;
}

/** The compounds we have a seed for. Anything else returns null. */
type CompoundKey = 'squat' | 'deadlift' | 'bench' | 'overhead' | 'row';

/**
 * Male, beginner, 8–12 rep working weight as a fraction of bodyweight.
 * Bias intentionally LOW — these are the conservative end of every published
 * standard table, picked so a first set always feels easy.
 */
const MALE_BEGINNER_RATIO: Record<CompoundKey, number> = {
  squat: 0.50,
  deadlift: 0.60,
  bench: 0.35,
  overhead: 0.25,
  row: 0.35,
};

/** Multiplier on the male-beginner base ratio by training experience.
 *  Intermediate / advanced shifts are gentle — a "beginner" seed that's a
 *  bit light for an experienced lifter is fine (they bump it after one set);
 *  the inverse error is unsafe. */
const LEVEL_MULTIPLIER: Record<FitnessLevel, number> = {
  beginner: 1.0,
  intermediate: 1.4,
  advanced: 1.8,
};

/** Female lifters seed at ~65% of the male ratio for upper-body compounds
 *  and ~70% for lower-body. 'unspecified' uses the female multiplier so
 *  we under-seed when in doubt. */
const SEX_MULTIPLIER_BY_GROUP: Record<'upper' | 'lower', Record<Sex, number>> = {
  upper: { male: 1.0, female: 0.65, unspecified: 0.65 },
  lower: { male: 1.0, female: 0.70, unspecified: 0.70 },
};

const COMPOUND_GROUP: Record<CompoundKey, 'upper' | 'lower'> = {
  squat: 'lower',
  deadlift: 'lower',
  bench: 'upper',
  overhead: 'upper',
  row: 'upper',
};

/** Floor to a 2.5 kg plate. Floor (not round) is the conservative-bias rule:
 *  a 27 kg theoretical seed becomes 25 kg, not 27.5. Minimum 20 kg — the
 *  bar itself, no plates. We don't seed below an empty bar. */
function floorToPlate(kg: number): number {
  const stepped = Math.floor(kg / 2.5) * 2.5;
  return Math.max(20, stepped);
}

/**
 * Map a catalog exercise name to one of the compounds we have a seed for.
 * Case-insensitive substring match against a small whitelist. Returns null
 * for isolations or unrecognised compounds so the caller stays in the
 * calibration branch instead of inventing a number for, say, a fly.
 *
 * Order matters: "Close Grip Bench Press" is a tricep variation — we treat
 * it as bench seed because the loading is bench-shaped. "Overhead Press"
 * must be checked before bare "press" never appears because we don't match
 * "press" alone.
 */
export function classifyCompound(liftName: string | null | undefined): CompoundKey | null {
  if (!liftName || typeof liftName !== 'string') return null;
  const n = liftName.toLowerCase();

  // Order matters within each branch: longer / more-specific phrases first
  // so "Overhead Tricep Extension" doesn't accidentally match overhead.
  if (n.includes('overhead press') || n.includes('military press') || n.includes('shoulder press')) {
    return 'overhead';
  }
  if (n.includes('deadlift')) return 'deadlift';
  if (n.includes('squat')) return 'squat';
  if (n.includes('bench press') || n.includes('bench')) return 'bench';
  // "Barbell Row" / "Bent Over Row" / "Pendlay Row" — bodyweight rows and
  // cable/seated rows don't have a single canonical loading curve, so we
  // restrict to free-weight variants to stay honest.
  if ((n.includes('barbell row') || n.includes('bent over row') || n.includes('pendlay row'))) {
    return 'row';
  }
  return null;
}

/**
 * Conservative starting working weight in kg, or null if we can't produce
 * one honestly. See module docstring for the bias rules.
 */
export function estimateStartingLoad(input: StartingLoadInput): number | null {
  const { level, bodyweightKg, sex, liftName } = input;

  if (bodyweightKg == null) return null;
  if (!Number.isFinite(bodyweightKg)) return null;
  // Range guard mirrors the migration CHECK; an out-of-range value is data
  // we don't trust enough to multiply against.
  if (bodyweightKg < 25 || bodyweightKg > 300) return null;

  const compound = classifyCompound(liftName);
  if (!compound) return null;

  const levelMult = LEVEL_MULTIPLIER[level];
  if (!levelMult) return null;

  const group = COMPOUND_GROUP[compound];
  const sexKey: Sex = sex ?? 'unspecified';
  const sexMult = SEX_MULTIPLIER_BY_GROUP[group][sexKey];
  if (sexMult == null) return null;

  const raw = bodyweightKg * MALE_BEGINNER_RATIO[compound] * levelMult * sexMult;
  if (!Number.isFinite(raw) || raw <= 0) return null;

  return floorToPlate(raw);
}
