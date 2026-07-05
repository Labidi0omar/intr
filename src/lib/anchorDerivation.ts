// Anchor-derived starting weights for no-history exercises.
//
// The problem: after the bodyweight-guess seed was removed (see git log —
// startingLoad.ts, deleted), a lift with no prescription and no logged
// history left the weight-input box blank, matching the Coach's Call's
// "First time on this — we'll find your weight as you go." That's honest
// for a lift the user has told us NOTHING about, but overkill for, say,
// Incline Barbell Bench Press when the user just anchored Flat Bench at
// onboarding — the app already knows roughly what this person can lift
// on a horizontal chest press.
//
// This module bridges that gap WITHOUT resurrecting the bodyweight guess.
// Instead of estimating from bodyweight + fitness level, it estimates from
// the user's own logged anchor working weights (src/lib/anchorSeed.ts) —
// numbers grounded in what they actually told us, not a demographic
// average. Every catalog exercise that plausibly correlates with one of
// the five anchor lifts (bench / squat / deadlift / overhead / row) maps
// to { anchor, ratio }; anchorWorkingWeight × ratio ≈ a credible logged
// weight for that specific exercise. Exercises with no defensible anchor
// relationship (bodyweight movements, ab/core work) are deliberately left
// OUT of the map — deriveFromAnchors returns null for them, same as if
// the anchor itself were missing, and the caller falls back to a blank
// box + the plain first-time line. A guess that can't be grounded in
// something the user told us is exactly the failure mode this module
// exists to avoid repeating.
//
// Pure: no Supabase, no AsyncStorage, no React. The caller (app/workout.tsx)
// reads the user's current anchor working weights out of `lastWeights`
// (which already reflects the onboarding seed, or a real logged session
// that has since overwritten it) and passes them in.
//
// ── Two correctness layers on top of the raw ratio ──────────────────────
//
// 1. FLOOR. A pure ratio collapses at low anchor weights: a 20kg-bench
//    beginner's Tricep Pushdown at ratio 0.25 comes out to 5kg, which is
//    absurd — nobody pushes down 5kg, and a cable stack/machine's own
//    minimum usually sits well above what strict proportional scaling
//    predicts. Every cable/machine/dumbbell-isolation entry below carries
//    a `floorKg` — a beginner-sane minimum for THAT specific movement,
//    calibrated per muscle group (see the per-section comments). The
//    floor only ever pulls a too-light number UP; it never caps a high
//    one down. Barbell compound variants of the anchor itself (Incline/
//    Decline/Close-Grip Bench, RDL, front squat, upright row, …) get NO
//    floor: they use the same loading mechanism as the anchor, so the
//    ratio already scales correctly at every strength level — a beginner
//    genuinely can't incline-press more than they flat-bench, and
//    flooring that relationship would risk suggesting a load heavier than
//    the anchor lift they just told us about.
//
//    KNOWN EDGE CASE, deliberately not "fixed": at a TRUE bar-only anchor
//    (e.g. anchorWorkingWeight === 20, an empty Olympic bar), a no-floor
//    barbell variant with ratio < 1.0 (Incline Bench, Upright Row, RDL, …)
//    computes to a number BELOW what an empty bar itself weighs — nobody
//    can load "17.5kg" on a 20kg bar. This is accepted rather than
//    special-cased: it only occurs for the rare true-absolute-beginner
//    anchor, the honest real-world answer in that case IS "use the empty
//    bar" (or whatever the lightest bar the gym stocks is), and adding a
//    bar-weight floor would need to know which bar the user's gym has,
//    which this module has no way to know. See the report for the full
//    reasoning.
//
// 2. EQUIPMENT-AWARE ROUNDING. The floor alone isn't enough — the FINAL
//    number also has to land on a weight that physically exists for that
//    exercise's equipment. Dumbbells come in fixed increments (a gym
//    rack has a 10kg dumbbell and a 12.5kg dumbbell; it does not have an
//    "11.3kg" or "8kg" dumbbell), so every dumbbell-equipment exercise
//    rounds through roundToDumbbellKg (2.5kg steps, 5kg minimum per
//    hand) instead of the barbell/cable/machine plate grid (roundToPlate,
//    2.5kg steps, 2.5kg minimum). Rounding happens LAST, after the floor
//    is applied in raw (unrounded) weight-space — max(raw, floorKg) THEN
//    round — so a floor value that isn't itself grid-aligned still comes
//    out correct (this is exactly how the pre-fix code shipped a literal
//    "8kg" floor for Incline Dumbbell Press: the old order rounded the
//    ratio result first, then took max() against an unrounded floor
//    constant, so the floor could leak through unrounded).

import { EXERCISES } from '../constants/exercises';
import type { AnchorLiftKey } from './anchorSeed';
import { roundToPlate } from './loadPrescription';

export interface DeriveFromAnchorsArgs {
  /** Exact catalog exercise name (EXERCISES[i].name) — the lift we're
   *  trying to seed a starting weight for. */
  exerciseName: string;
  /** The user's current working weight per anchor lift, keyed by the same
   *  AnchorLiftKey vocabulary as anchorSeed.ts. Build this from lastWeights
   *  at the five canonical anchor exercise names (Barbell Bench Press,
   *  Barbell Squat, Deadlift, Overhead Press, Barbell Row) — see
   *  buildAnchorWorkingWeights below. Missing/absent keys mean "the user
   *  never anchored (or hasn't yet logged) that lift." */
  anchorWorkingWeights: Partial<Record<AnchorLiftKey, number>>;
  /** Reserved, NOT consumed by v1. Every ratio below already bakes in the
   *  target exercise's typical rep range relative to its anchor (that's
   *  the "no separate unit logic" contract in the product spec) — there's
   *  no second e1RM/rep-range conversion layered on top here. Accepted in
   *  the signature so a future refinement (e.g. adjusting for a deload
   *  week's bumped rep range) has a place to plug in without a breaking
   *  API change; today it is a no-op. */
  targetReps?: number;
}

interface AnchorMapEntry {
  anchor: AnchorLiftKey;
  /** anchorWorkingWeight × ratio ≈ a credible working weight for THIS
   *  exercise, at ITS OWN catalog rep range and an assumed ~2 RIR — the
   *  same assumption the anchor seed itself uses. Tuned conservative: for
   *  exercises that structurally move MORE weight than their anchor (leg
   *  press, hip thrust — shorter range of motion, machine-assisted
   *  stability), "conservative" means the LOW end of the commonly-cited
   *  multiplier, not artificially capping the ratio at 1.0 — a leg press
   *  estimate at squat-equivalent weight would look just as broken to a
   *  lifter as the old bodyweight guess did. */
  ratio: number;
  /**
   * Beginner-sane minimum (kg), compared against the RAW (pre-rounding)
   * ratio result — see deriveFromAnchors for the exact order of
   * operations. Reserved for cable/machine/dumbbell-isolation exercises
   * where a stack/machine/dumbbell-increment floor — not proportional
   * strength — is the real limiter. Calibrated per muscle group against
   * beginner-realistic targets (module docstring + report), NOT a single
   * blanket number — a beginner's Tricep Pushdown floor (~20kg, a cable
   * stack) and their Lateral Raise floor (~5kg, tiny dumbbells) are
   * nowhere near the same magnitude, even though both are "isolation."
   * Omitted (undefined) entirely for the barbell-compound family where no
   * floor applies (see the module docstring). Values here don't need to
   * be pre-aligned to the equipment's grid — deriveFromAnchors rounds
   * AFTER applying the floor, so authoring a slightly-off constant can
   * never leak an off-grid number to the user (the original bug this
   * fix closes). */
  floorKg?: number;
}

/** Short display label per anchor, used in the Coach's Call's "estimated
 *  from your {label}" line. */
export const ANCHOR_BASIS_LABEL: Readonly<Record<AnchorLiftKey, string>> = {
  bench: 'bench',
  squat: 'squat',
  deadlift: 'deadlift',
  overhead: 'overhead press',
  row: 'row',
};

// ── The anchor + ratio map ──────────────────────────────────────────────
// Grouped by movement pattern per the product spec. Bodyweight-equipment
// exercises are excluded entirely (the Coach's Call/prefill never engages
// for them — shouldShowCoachCall suppresses on equipment === 'bodyweight').
// Ab/core work is excluded too: no anchor has a defensible strength
// relationship to weighted trunk flexion, and a fabricated ratio there
// would be exactly the "forced near the anchor" mistake the spec warns
// against. The five anchor exercises themselves (Barbell Bench Press,
// Barbell Squat, Deadlift, Overhead Press, Barbell Row) are also excluded
// — they're never derivation TARGETS in practice (if the user has no
// history for one of them, there's by definition no anchorWorkingWeight
// to derive from either).
//
// Calf raises (Seated/Standing Calf Raise) ARE mapped, to squat, despite
// squat strength being a genuinely weak predictor of calf-raise capacity
// — flagged explicitly below. The product call is that a floor-dominated
// "≈40kg, estimated from your squat" beats a blank box even when the
// correlation is soft; the floor does almost all the work here, not the
// ratio.
const ANCHOR_DERIVATION_MAP: Readonly<Record<string, AnchorMapEntry>> = {
  // ── Horizontal push → bench ──────────────────────────────────────────
  // Barbell bench-press variants: NO FLOOR. Same bar-and-plates loading
  // mechanism as the anchor itself, so the ratio scales correctly at
  // every strength level — a true beginner who can only bench the empty
  // bar genuinely can't incline/decline/close-grip MORE than that either.
  // Flooring these would risk suggesting a load heavier than the anchor
  // lift the beginner just told us about.
  'Incline Barbell Bench Press':        { anchor: 'bench', ratio: 0.85 },
  'Decline Barbell Press':               { anchor: 'bench', ratio: 0.95 },
  'Close Grip Bench Press':              { anchor: 'bench', ratio: 0.85 },
  'Paused Bench Press':                  { anchor: 'bench', ratio: 0.85 },
  'Board Press':                         { anchor: 'bench', ratio: 0.95 },
  // Dumbbell presses — the barbell→dumbbell per-hand ratio is ~0.45: two
  // dumbbells summing to roughly 80-90% of the barbell load is the
  // commonly-cited real-world relationship, and 0.45/hand never exceeds
  // half the barbell number (80kg bench × 0.45 = 36kg/hand — a safe,
  // realistic cap, not a floor-dominated guess). Incline/Decline scale
  // off that same 0.45 using the same barbell incline/decline ratios
  // (0.85 / 0.95) applied to it, so the DB family stays internally
  // consistent with the barbell family. Floor calibrated to "DB bench
  // ~12.5/hand" / "incline DB ~10" — still needed at a beginner anchor
  // (20kg bench × 0.45 = 9kg/hand, below what a beginner can actually
  // stabilize on the bench).
  'Dumbbell Bench Press':                { anchor: 'bench', ratio: 0.45, floorKg: 12.5 }, // per-dumbbell
  'Incline Dumbbell Press':              { anchor: 'bench', ratio: 0.38, floorKg: 10 },   // per-dumbbell, ~0.45 × 0.85 (incline-vs-flat)
  'Decline Dumbbell Press':              { anchor: 'bench', ratio: 0.42, floorKg: 12.5 }, // per-dumbbell, ~0.45 × 0.95 (decline-vs-flat)
  // Cable/dumbbell chest isolation — floor calibrated to "cable fly ~10".
  'Cable Fly':                           { anchor: 'bench', ratio: 0.20, floorKg: 10 }, // per side
  'High Cable Fly':                      { anchor: 'bench', ratio: 0.20, floorKg: 10 }, // per side
  'Dumbbell Fly':                        { anchor: 'bench', ratio: 0.15, floorKg: 7.5 }, // per-dumbbell
  'Dumbbell Pullover':                   { anchor: 'bench', ratio: 0.28, floorKg: 10 }, // single DB, both hands
  // Triceps accessory work is downstream of pressing strength — bucketed
  // under bench with small isolation ratios rather than left unmapped.
  // Floor calibrated to "tricep pushdown ~20" (cable) / "overhead
  // extension ~10" (dumbbell) / "kickback ~5" (dumbbell). Pushdown ratio
  // bumped 0.25 -> 0.28 so it clears its own floor with daylight at a
  // realistic intermediate anchor instead of landing in a coincidental
  // tie (80kg bench previously gave exactly 20, indistinguishable from
  // the floor winning).
  'Tricep Pushdown':                     { anchor: 'bench', ratio: 0.28, floorKg: 20 }, // per-side cable stack
  'Cable Overhead Tricep Extension':     { anchor: 'bench', ratio: 0.22, floorKg: 20 }, // per-side cable stack, same tier as pushdown
  'Overhead Tricep Extension':           { anchor: 'bench', ratio: 0.18, floorKg: 10 }, // per-dumbbell
  'Tricep Kickback':                     { anchor: 'bench', ratio: 0.10, floorKg: 5 },  // per-dumbbell
  'Skull Crushers':                      { anchor: 'bench', ratio: 0.22, floorKg: 12.5 }, // EZ/straight bar
  'EZ Bar Skull Crusher':                { anchor: 'bench', ratio: 0.22, floorKg: 12.5 },

  // ── Vertical push → overhead ─────────────────────────────────────────
  'Seated Barbell Press':                { anchor: 'overhead', ratio: 0.90 }, // barbell — NO FLOOR, same reasoning as bench variants
  // Same ~0.45 barbell→dumbbell per-hand ratio as the bench family
  // (never exceeds ~0.5 of the barbell number). Arnold Press is a harder
  // variant (rotation through the bottom) — kept a notch below standard
  // DB pressing. Floor calibrated to "DB shoulder press ~10".
  'Dumbbell Shoulder Press':             { anchor: 'overhead', ratio: 0.45, floorKg: 10 }, // per-dumbbell
  'Seated Dumbbell Press':               { anchor: 'overhead', ratio: 0.45, floorKg: 10 }, // per-dumbbell
  'Arnold Press':                        { anchor: 'overhead', ratio: 0.42, floorKg: 10 }, // per-dumbbell
  'Machine Shoulder Press':              { anchor: 'overhead', ratio: 0.70, floorKg: 15 }, // weight-stack numbers aren't apples-to-apples with free weight — see report caveat
  // Floor calibrated to "lateral raise ~5" / "front raise ~5".
  'Lateral Raise':                       { anchor: 'overhead', ratio: 0.18, floorKg: 5 }, // per-dumbbell
  'Front Raise':                         { anchor: 'overhead', ratio: 0.16, floorKg: 5 }, // per-dumbbell
  'Cable Lateral Raise':                 { anchor: 'overhead', ratio: 0.18, floorKg: 5 }, // per-side cable stack
  // Not a textbook "vertical push", but shares the shoulder-pressing
  // muscle group and the catalog files it under push/shoulders — see
  // report for the borderline-classification flag. Barbell — no floor.
  'Upright Row':                         { anchor: 'overhead', ratio: 0.45 },

  // ── Horizontal/vertical pull, rear delts, biceps → row ───────────────
  'T-Bar Row':                           { anchor: 'row', ratio: 0.90, floorKg: 15 }, // loaded apparatus has its own real minimum
  // Floor calibrated to "DB row ~12.5".
  'Dumbbell Row':                        { anchor: 'row', ratio: 0.45, floorKg: 12.5 }, // per-dumbbell, single-arm
  'Chest Supported Row':                 { anchor: 'row', ratio: 0.42, floorKg: 12.5 }, // per-dumbbell
  // Floor calibrated to "lat pulldown ~30" / "seated/cable row ~30".
  'Lat Pulldown':                        { anchor: 'row', ratio: 0.70, floorKg: 30 }, // weight-stack — see report caveat
  'Close Grip Lat Pulldown':             { anchor: 'row', ratio: 0.68, floorKg: 30 }, // weight-stack, same machine class
  'Cable Row':                           { anchor: 'row', ratio: 0.80, floorKg: 30 }, // weight-stack
  'Wide Grip Cable Row':                 { anchor: 'row', ratio: 0.80, floorKg: 30 }, // weight-stack
  // Floor calibrated to "face pull ~10".
  'Face Pull':                           { anchor: 'row', ratio: 0.20, floorKg: 10 }, // weight-stack
  'Cable Face Pull High':                { anchor: 'row', ratio: 0.18, floorKg: 10 }, // weight-stack
  // Floor calibrated to "rear-delt fly ~5".
  'Reverse Fly':                         { anchor: 'row', ratio: 0.12, floorKg: 5 }, // per-dumbbell
  'Bent Over Rear Delt Fly':             { anchor: 'row', ratio: 0.10, floorKg: 5 }, // per-dumbbell
  'Seated Rear Delt Raise':              { anchor: 'row', ratio: 0.10, floorKg: 5 }, // per-dumbbell
  'Rear Delt Barbell Row':               { anchor: 'row', ratio: 0.35, floorKg: 7.5 }, // light barbell accessory, not a true compound variant
  // Curls — floor calibrated to "barbell curl ~15" / "DB curl ~7.5".
  // Cable Curl sits between the two implement classes (a fixed cable
  // handle, not a free bar or a per-hand dumbbell) — 10 is a judgment
  // call, not an explicit target; see report.
  'Barbell Curl':                        { anchor: 'row', ratio: 0.35, floorKg: 15 },
  'EZ Bar Curl':                         { anchor: 'row', ratio: 0.33, floorKg: 15 },
  'Preacher Curl':                       { anchor: 'row', ratio: 0.30, floorKg: 15 },
  'Cable Curl':                          { anchor: 'row', ratio: 0.30, floorKg: 10 }, // weight-stack — judgment call, see report
  // Dumbbell Curl bumped 0.16 -> 0.18 to match Hammer Curl's ratio — at a
  // realistic intermediate anchor (row 70kg) the old ratio gave 10kg/hand,
  // noticeably lighter than what most intermediate lifters actually curl;
  // 0.18 lands on a more typical 12.5kg/hand without changing the
  // (still floor-dominated) beginner number.
  'Dumbbell Curl':                       { anchor: 'row', ratio: 0.18, floorKg: 7.5 }, // per-dumbbell
  'Hammer Curl':                         { anchor: 'row', ratio: 0.18, floorKg: 7.5 }, // per-dumbbell
  'Incline Dumbbell Curl':               { anchor: 'row', ratio: 0.14, floorKg: 7.5 }, // per-dumbbell
  'Concentration Curl':                  { anchor: 'row', ratio: 0.14, floorKg: 7.5 }, // per-dumbbell
  'Zottman Curl':                        { anchor: 'row', ratio: 0.14, floorKg: 7.5 }, // per-dumbbell

  // ── Squat pattern → squat ────────────────────────────────────────────
  // Leg Press is the single riskiest entry in this table — see report.
  // Machine leg-press "weight" conventions vary enormously (sled angle,
  // unloaded-sled weight) between gyms; 1.5x is the CONSERVATIVE end of
  // the commonly cited 1.5–2.5x squat-to-leg-press range, not a cap
  // imposed to keep every ratio ≤ 1 — that would be its own credibility
  // failure in the opposite direction (an obviously-too-light leg press
  // number reads as broken to anyone who's used a leg press machine).
  // Floor calibrated to "leg press ~60": most leg-press sleds have real
  // unloaded weight (often 20-45kg) before a single plate goes on, so a
  // bare-ratio number at a beginner anchor can undershoot what the empty
  // machine itself weighs.
  'Leg Press':                           { anchor: 'squat', ratio: 1.50, floorKg: 60 },
  'Hack Squat':                          { anchor: 'squat', ratio: 1.30, floorKg: 40 }, // same sled-weight reasoning, lighter carriage than leg press
  // Floor calibrated to "DB lunge ~10".
  'Goblet Squat':                        { anchor: 'squat', ratio: 0.30, floorKg: 10 }, // single DB/KB held at chest
  'Dumbbell Lunges':                     { anchor: 'squat', ratio: 0.20, floorKg: 10 }, // per-dumbbell
  // Floor calibrated to "leg extension ~20".
  'Leg Extension':                       { anchor: 'squat', ratio: 0.45, floorKg: 20 }, // weight-stack
  // Calf raises — see the map-level docstring above: squat is a soft
  // predictor here, the floor does almost all the work at a beginner
  // anchor. Ratio bumped 0.45 -> 1.0 at the top end: calf muscles are
  // strong and the ROM is short, so a calf-raise machine routinely moves
  // AT LEAST as much as a lifter's squat, often more (0.45 gave a
  // 100kg-squatter only 45kg, which reads as broken to anyone who's used
  // a calf-raise machine — the same "too light to be credible" failure
  // the leg-press ratio was tuned to avoid). 1.0 is still the
  // conservative end of what's commonly observed. Floor calibrated to
  // "calf raise ~40".
  'Seated Calf Raise':                   { anchor: 'squat', ratio: 1.0, floorKg: 40 }, // weight-stack
  'Standing Calf Raise':                 { anchor: 'squat', ratio: 1.0, floorKg: 40 }, // weight-stack

  // ── Hinge → deadlift ──────────────────────────────────────────────────
  // Romanian Deadlift: barbell variant of the anchor itself — NO FLOOR,
  // same "can't RDL more than you deadlift" reasoning as the bench-variant
  // family above.
  'Romanian Deadlift':                   { anchor: 'deadlift', ratio: 0.75 },
  'Dumbbell RDL':                        { anchor: 'deadlift', ratio: 0.35, floorKg: 10 }, // per-dumbbell — different equipment class than the anchor, floors like other DB accessories
  // Floor calibrated to "leg curl ~20".
  'Leg Curl':                            { anchor: 'deadlift', ratio: 0.30, floorKg: 20 }, // weight-stack
  // Hip Thrust is the second riskiest entry — hip thrusts commonly load
  // WELL past deadlift (short range of motion, lockout-favorable strength
  // curve); 1.3x is the conservative end of a commonly cited 1.3–1.8x
  // range. See report. Barbell/plate-loaded — no floor needed; even at a
  // 20kg deadlift anchor the ratio alone clears a bar-only load.
  'Hip Thrust':                          { anchor: 'deadlift', ratio: 1.30 },
  'Back Extension':                      { anchor: 'deadlift', ratio: 0.15, floorKg: 10 }, // held plate, machine-assisted
};

/** Real dumbbell increments: 2.5kg steps, 5kg minimum per hand. A gym
 *  dumbbell rack has a 10kg and a 12.5kg dumbbell; it does not have an
 *  "8kg" or "11.3kg" one, and the lightest pair almost everywhere is
 *  ≥5kg. Distinct from roundToPlate's 2.5kg-minimum plate grid — a
 *  barbell CAN be loaded to 2.5kg empty-bar-adjacent territory (small
 *  plates exist), a dumbbell rack usually doesn't stock anything under
 *  a light-but-still-substantial minimum pair. */
function roundToDumbbellKg(kg: number): number {
  const rounded = Math.round(kg / 2.5) * 2.5;
  return Math.max(5, rounded);
}

/** Equipment → catalog exercise name, built once from EXERCISES so
 *  deriveFromAnchors doesn't do an O(n) scan per call. Barbell, cable,
 *  and machine exercises all share the plate grid (roundToPlate) — cable/
 *  machine stacks commonly step in either 2.5kg or 5kg, and 2.5kg is a
 *  valid choice within that range, so reusing the same grid as barbell
 *  keeps the rounding logic to two modes instead of three. Only
 *  `equipment === 'dumbbell'` gets the distinct dumbbell grid. */
const EQUIPMENT_BY_EXERCISE_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  EXERCISES.map(e => [e.name, e.equipment]),
);

/** Rounds a raw kg value to a weight that physically exists for the given
 *  exercise's equipment. Falls back to the plate grid when the exercise
 *  isn't in the catalog (shouldn't happen for anything reachable through
 *  deriveFromAnchors, since every map key is a real catalog name, but a
 *  defensive fallback beats a crash). */
function roundForEquipment(kg: number, exerciseName: string): number {
  const equipment = EQUIPMENT_BY_EXERCISE_NAME[exerciseName];
  return equipment === 'dumbbell' ? roundToDumbbellKg(kg) : roundToPlate(kg);
}

/**
 * Given a target exercise name and the user's current anchor working
 * weights, returns a credible starting weight in kg, or null when there's
 * nothing to derive from — the exercise isn't in the map, or the anchor it
 * maps to hasn't been logged (never seeded at onboarding, or was seeded
 * but the value is non-positive/missing).
 *
 * final = roundForEquipment(max(anchorWorkingWeight × ratio, floorKg ?? -∞))
 *
 * Order matters: the floor is applied to the RAW ratio result, and
 * equipment-aware rounding happens LAST, once, on whichever of the two
 * (ratio or floor) is larger. This guarantees the output always lands on
 * a weight that exists for that equipment, regardless of whether the
 * ratio result or the floorKg constant was off-grid going in — rounding
 * BEFORE taking the max (the original implementation) could let an
 * unrounded floor constant leak straight through to the user, which is
 * exactly how a literal "8kg" dumbbell estimate shipped for Incline
 * Dumbbell Press. The floor only ever pulls a too-light ratio UP; it
 * never caps a high value down (Leg Press/Hip Thrust legitimately exceed
 * their anchor; the floor doesn't touch that). Exercises with no floorKg
 * (the barbell-compound family) are pure ratio, rounded to the plate
 * grid, at every anchor level by design; see the AnchorMapEntry.floorKg
 * doc comment.
 */
export function deriveFromAnchors(args: DeriveFromAnchorsArgs): number | null {
  const entry = ANCHOR_DERIVATION_MAP[args.exerciseName];
  if (!entry) return null;

  const anchorWeight = args.anchorWorkingWeights[entry.anchor];
  if (typeof anchorWeight !== 'number' || !(anchorWeight > 0)) return null;

  const raw = anchorWeight * entry.ratio;
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const withFloor = entry.floorKg != null ? Math.max(raw, entry.floorKg) : raw;
  return roundForEquipment(withFloor, args.exerciseName);
}

/**
 * Which anchor a target exercise derives from, or null when the exercise
 * isn't in the map. Separate from deriveFromAnchors (which returns just
 * the number, per spec) so callers that need to LABEL the estimate — e.g.
 * the Coach's Call's "≈70kg, estimated from your bench" line — can look up
 * ANCHOR_BASIS_LABEL[basisForExercise(name)] without deriveFromAnchors's
 * return type growing a second shape. Does NOT check anchorWorkingWeights —
 * it answers "what WOULD this derive from," independent of whether that
 * anchor has actually been logged.
 */
export function basisForExercise(exerciseName: string): AnchorLiftKey | null {
  return ANCHOR_DERIVATION_MAP[exerciseName]?.anchor ?? null;
}

/**
 * Builds the `anchorWorkingWeights` input deriveFromAnchors expects, from
 * a map of exercise_name → current working weight (i.e. lastWeights,
 * keyed by canonical catalog name — the caller is responsible for
 * resolving normalizeExName lookups before calling this; see
 * app/workout.tsx's usage for the exact wiring). Anchors with no entry (or
 * a non-positive one) are simply absent from the result — deriveFromAnchors
 * already treats a missing key as "not anchored."
 */
export function buildAnchorWorkingWeights(
  weightsByCanonicalExerciseName: Partial<Record<string, number | undefined>>,
  anchorLifts: readonly { key: AnchorLiftKey; exerciseName: string }[],
): Partial<Record<AnchorLiftKey, number>> {
  const out: Partial<Record<AnchorLiftKey, number>> = {};
  for (const def of anchorLifts) {
    const w = weightsByCanonicalExerciseName[def.exerciseName];
    if (typeof w === 'number' && w > 0) out[def.key] = w;
  }
  return out;
}
