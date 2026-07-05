// Onboarding anchor-lift seeding.
//
// Onboarding asks an optional "what are you lifting these days?" question
// for the five anchor compounds. This module turns whatever the user fills
// in into REAL exercise_logs history so session one hits the normal
// prescription path (prescribeLoad) instead of the bare cold-start
// calibration line — no bodyweight-guess seed, no fake 35kg number.
//
// The credibility problem this exists to solve: the anchor entry is a
// near-max effort (e.g. "100kg x 5", a ~5-rep max), but the plan's actual
// working sets for that lift are almost always a higher-rep range (e.g.
// 8–12 for Barbell Bench Press). Writing 100kg straight into exercise_logs
// and letting prescribeLoad treat it as "last session's working weight"
// would produce a nonsense number (~100kg for a 12-rep set is not a real
// working weight for anyone). estimateWorkingWeightKg converts the anchor
// through an e1RM (estimated one-rep max) so the seeded weight is the
// credible one for the exercise's ACTUAL rep range.
//
// Pure: no Supabase, no AsyncStorage, no clock (the caller passes
// `todayIso`). The caller (app/onboarding.tsx) is responsible for the
// actual insert (adding user_id/session_id) and for writing the returned
// `notes` map to AsyncStorage so app/workout.tsx can render the "based on
// your 100×5" Coach's Call line — see prescriptionPresenter.ts's
// `anchorSeed` field.
//
// Assumption, spelled out because it's a real modeling choice: the seeded
// row is stamped with reps_in_reserve = ANCHOR_SEED_RIR (2), a moderate
// "two reps in the tank" effort. We do NOT ask the user for RIR on the
// anchor entry — one more number would cost onboarding completion for
// something the user can't estimate before they've done the lift under
// this app's coaching anyway. RIR 2 is the same "target zone" the RIR
// ladder in loadPrescription.ts treats as a small-bump-worthy clean set,
// so the very first prescribed session nudges up gently rather than
// repeating the seed forever.

import { EXERCISES } from '../constants/exercises';
import { roundToPlate } from './loadPrescription';

/** The five anchor compounds onboarding asks about. */
export type AnchorLiftKey = 'bench' | 'squat' | 'deadlift' | 'overhead' | 'row';

export interface AnchorLiftDef {
  key: AnchorLiftKey;
  /** Onboarding row label. */
  label: string;
  /** Canonical catalog name — MUST match an EXERCISES entry exactly so the
   *  seeded exercise_logs row keys identically to real logged sets for
   *  this lift (normalizeExName handles casing/whitespace on the read
   *  side; this is the canonical write-side name). */
  exerciseName: string;
}

/** Order is the onboarding row order. */
export const ANCHOR_LIFTS: readonly AnchorLiftDef[] = [
  { key: 'bench', label: 'Bench', exerciseName: 'Barbell Bench Press' },
  { key: 'squat', label: 'Squat', exerciseName: 'Barbell Squat' },
  { key: 'deadlift', label: 'Deadlift', exerciseName: 'Deadlift' },
  { key: 'overhead', label: 'Overhead Press', exerciseName: 'Overhead Press' },
  { key: 'row', label: 'Barbell Row', exerciseName: 'Barbell Row' },
];

export interface AnchorEntry {
  weightKg: number;
  reps: number;
}

// Bounds mirror onboarding's other numeric inputs (see BODYWEIGHT_MIN_KG /
// BODYWEIGHT_MAX_KG in app/onboarding.tsx): loose enough to accept any real
// answer, tight enough that a fat-fingered entry doesn't become a fake
// "record" that later corrupts a prescription. Reps is capped at 20 — past
// that, Epley-style e1RM formulas are known to drift (the whole
// rep-max-percentage curve gets noisy at high reps), so we'd rather treat
// an oddball high-rep entry as unparseable (falls back to calibration) than
// silently produce a garbage seed. This is a real limitation of the
// conversion, not a UI nitpick — see estimateWorkingWeightKg's docstring.
const ANCHOR_WEIGHT_MIN_KG = 5;
const ANCHOR_WEIGHT_MAX_KG = 400;
const ANCHOR_REPS_MIN = 1;
const ANCHOR_REPS_MAX = 20;

/** Parse + validate one anchor row's raw text inputs. Decimal-tolerant on
 *  weight (comma or dot). Returns null on empty/unparseable/out-of-range
 *  input — every anchor is independently optional, so "null" just means
 *  "this one wasn't filled in," not an error to surface. */
export function parseAnchorEntry(weightRaw: string, repsRaw: string): AnchorEntry | null {
  const weightNorm = (weightRaw ?? '').replace(',', '.').trim();
  const repsNorm = (repsRaw ?? '').trim();
  if (!weightNorm || !repsNorm) return null;

  const weightKg = Number(weightNorm);
  const reps = Number(repsNorm);
  if (!Number.isFinite(weightKg) || !Number.isFinite(reps)) return null;
  if (weightKg < ANCHOR_WEIGHT_MIN_KG || weightKg > ANCHOR_WEIGHT_MAX_KG) return null;
  if (!Number.isInteger(reps) || reps < ANCHOR_REPS_MIN || reps > ANCHOR_REPS_MAX) return null;

  return { weightKg: Math.round(weightKg * 100) / 100, reps };
}

/** Assumed reps-in-reserve stamped on every seeded row. See module
 *  docstring for why we don't ask the user for this. */
export const ANCHOR_SEED_RIR = 2;

/** How many days in the past the seeded log is dated. Far enough that it
 *  reads as prior history (not "today's session") and never collides with
 *  a real logged_date if the user completes session one the same day they
 *  onboarded; recent enough that applyStallNudge's weeks-since math (which
 *  only fires at ≥ STALL_WEEKS = 3 weeks) can't mistake it for a stall. */
export const ANCHOR_SEED_DAYS_AGO = 7;

/** Epley estimated one-rep max: weight * (1 + reps/30). Standard formula,
 *  no dependency — same family of estimate used industry-wide for "what's
 *  my max from a rep-max set." Most accurate in the ~1–12 rep window,
 *  which is why entries are capped at ANCHOR_REPS_MAX (20) above; Epley
 *  (like every %1RM-based formula) drifts at higher rep counts. */
function estimate1RM(weightKg: number, reps: number): number {
  return weightKg * (1 + reps / 30);
}

/**
 * Converts a near-max anchor entry (e.g. 100kg x 5) into a credible WORKING
 * weight for `targetReps` at `assumedRir` reps in reserve — the number the
 * Coach's Call can honestly show for session one, instead of echoing the
 * raw entered weight at the wrong rep range.
 *
 * Method: estimate the lifter's 1RM from the entered (weight, reps) via
 * Epley, then invert Epley to solve for the weight that would put them at
 * (targetReps + assumedRir) reps to failure — i.e. a set of `targetReps`
 * with `assumedRir` left in the tank. Rounded to the nearest loadable plate
 * (roundToPlate, 2.5kg increments, same grid prescribeLoad uses).
 *
 * Worked example (see anchorSeed.test.ts + the PR report for the full
 * trace): 100kg x 5 entered, targetReps 10 (Barbell Bench Press's catalog
 * range "8-12" midpoint), assumedRir 2 → e1RM ≈ 116.7kg → weight for a
 * 12-rep-to-failure set ≈ 83.3kg → rounds to 82.5kg. That's a believable
 * ~70% of e1RM for a 10-rep working set — not the raw 100kg, not a
 * bodyweight guess.
 *
 * Returns 0 (not seedable) when any input is non-positive — callers should
 * skip writing a row in that case rather than seed a zero/negative weight.
 */
export function estimateWorkingWeightKg(
  enteredWeightKg: number,
  enteredReps: number,
  targetReps: number,
  assumedRir: number = ANCHOR_SEED_RIR,
): number {
  if (!(enteredWeightKg > 0) || !(enteredReps > 0) || !(targetReps > 0)) return 0;
  const e1rm = estimate1RM(enteredWeightKg, enteredReps);
  const effectiveFailureReps = targetReps + Math.max(0, assumedRir);
  const raw = e1rm / (1 + effectiveFailureReps / 30);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return roundToPlate(raw);
}

/** Parses a catalog `reps` string ("8-12", "5-8") into a single
 *  representative target rep count (rounded midpoint). Falls back to 10
 *  (a safe mid-hypertrophy default) for a missing/malformed range so a
 *  future catalog format change can't throw here — it can only degrade to
 *  a slightly-off seed, never a crash. */
export function targetRepsFromRange(repsRange: string | null | undefined): number {
  if (!repsRange) return 10;
  const m = repsRange.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) {
    const single = Number(repsRange);
    return Number.isFinite(single) && single > 0 ? Math.round(single) : 10;
  }
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return 10;
  return Math.round((lo + hi) / 2);
}

export interface AnchorSeedLogRow {
  exercise_name: string;
  weight_kg: number;
  reps_in_reserve: number;
  logged_date: string;
  is_recovery: false;
}

/** Shared AsyncStorage key — app/onboarding.tsx writes it, app/workout.tsx
 *  reads it. Centralized here so the two call sites can't drift apart. */
export const ANCHOR_SEED_NOTES_STORAGE_KEY = 'onboarding:anchorSeedNotes';

/** What the Coach's Call needs later to render "based on your 100×5" —
 *  the RAW entered numbers (not the converted weight_kg), plus the
 *  logged_date so the reader (app/workout.tsx) can confirm this seed is
 *  still the ONLY history for the lift before attributing a prescription
 *  to it. Cached locally (AsyncStorage) rather than in the DB: exercise_logs
 *  has no `reps` column and this task adds no schema change, so the raw
 *  (weight, reps) pair the user typed only survives as long as the local
 *  cache does. If it's lost (reinstall, different device), the seeded
 *  number itself is unaffected — only the attribution line stops showing. */
export interface AnchorSeedNote {
  enteredWeightKg: number;
  enteredReps: number;
  loggedDate: string;
}

export interface BuildAnchorSeedRowsResult {
  /** Ready for `supabase.from('exercise_logs').insert(...)` once the
   *  caller adds user_id (and session_id: null — these are history, not a
   *  workout_sessions-linked session). */
  rows: AnchorSeedLogRow[];
  /** Keyed by exercise_name (canonical catalog casing — callers normalize
   *  via normalizeExName on the read side, same convention lastWeights /
   *  exerciseHistory already use). */
  notes: Record<string, AnchorSeedNote>;
}

/** YYYY-MM-DD for (todayIso − days), local-date arithmetic (no timezone
 *  library dependency, matches every other date helper in this codebase). */
function daysBeforeIso(todayIso: string, days: number): string {
  const p = todayIso.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pure builder: turns whatever anchors the user filled in during onboarding
 * into exercise_logs-ready rows plus the local attribution-note cache.
 * Every anchor is independently optional — a missing/invalid entry for one
 * lift is silently skipped; it never blocks the others or throws.
 *
 * Deliberately produces NO workout_sessions row: these are history only.
 * They must not inflate a completed-session count or a rotation phase (see
 * the resume-rotation fix in planGeneration.ts) — only the mesocycle
 * position and streak reads workout_sessions, and this function never
 * touches that table.
 */
export function buildAnchorSeedRows(args: {
  anchors: Partial<Record<AnchorLiftKey, AnchorEntry | null | undefined>>;
  todayIso: string;
}): BuildAnchorSeedRowsResult {
  const loggedDate = daysBeforeIso(args.todayIso, ANCHOR_SEED_DAYS_AGO);
  const rows: AnchorSeedLogRow[] = [];
  const notes: Record<string, AnchorSeedNote> = {};

  for (const def of ANCHOR_LIFTS) {
    const entry = args.anchors[def.key];
    if (!entry || !(entry.weightKg > 0) || !(entry.reps > 0)) continue;

    const catalogEntry = EXERCISES.find(e => e.name === def.exerciseName);
    const targetReps = targetRepsFromRange(catalogEntry?.reps);
    const seededWeightKg = estimateWorkingWeightKg(entry.weightKg, entry.reps, targetReps);
    if (!(seededWeightKg > 0)) continue;

    rows.push({
      exercise_name: def.exerciseName,
      weight_kg: seededWeightKg,
      reps_in_reserve: ANCHOR_SEED_RIR,
      logged_date: loggedDate,
      is_recovery: false,
    });
    notes[def.exerciseName] = {
      enteredWeightKg: entry.weightKg,
      enteredReps: entry.reps,
      loggedDate,
    };
  }

  return { rows, notes };
}
