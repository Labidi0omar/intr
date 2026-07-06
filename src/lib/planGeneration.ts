// ──────────────────────────────────────────────────────────────────
// Plan generation — extracted from app/plan.tsx so onboarding (and
// future auto-regen surfaces) can call it directly.
//
// High-level API:
//   - splitForDays(n)   — maps training days/week to a preferred_split id
//   - currentWeekStart()— Monday of the current week as YYYY-MM-DD
//   - generatePlan(args)— produces a week of PlanDays for a user
// ──────────────────────────────────────────────────────────────────

import { EXERCISES } from '../constants/exercises';
import { goalReps, goalRest, goalSets, type Goal } from './goalProfile';
import {
  buildDayStructure,
  type BlockWeek,
  type DayStructure,
  type MuscleSlot,
} from './planRules';

/**
 * Generator version. Bump this by 1 whenever the plan-generation logic changes
 * in a way that should retroactively rebuild already-generated future weeks
 * (rotation order, exercise selection, day placement, etc.).
 *
 * Every persisted weekly_plans row is stamped with the version that produced
 * it. ensureCurrentWeekPlan treats a FUTURE row whose plan_version is below
 * this constant as stale and regenerates it — so a logic fix reaches existing
 * accounts on their next app open, with no manual SQL, row deletes, or rebuild.
 *
 * History:
 *   0 — implicit; all rows written before versioning existed (migration default).
 *   1 — first versioned generator (bro_split weeks 2+ stopped collapsing, but
 *       still drifted the weekly phase via globalI).
 *   2 — bro_split 'fixed' rotation is now a stable weekly template keyed on the
 *       in-week index, so every week is the same chest/back/shoulders/arms/legs
 *       assignment instead of drifting one slot per week.
 *   3 — mesocycle model: exercise selection is now deterministic per
 *       (blockIndex, dayType, muscle), seeded via mulberry32. Weeks 1–4 of a
 *       block return identical lifts (enables progressive overload); block N+1
 *       reshuffles to same-muscle variations. Math.random shuffles in
 *       pickExercises are gone — same input ⇒ same output.
 *   4 — deload as the final week of each 4-week block (blockWeek === 4).
 *       Working sets are cut to ~60% (ceil, floor at 1) and the rep range
 *       bumps +2 to signal lighter loads. Each deload day is labeled
 *       `deload: true` on the PlanDay so the UI and coach can say
 *       "deload week — back off, recover." Same exercises as weeks 1–3 of
 *       the block; only the dose changes.
 *   5 — exercise selection ranks by balanced score (effectiveness+popularity);
 *       guarantees a compound per major-muscle slot (back: vertical+horizontal);
 *       isPrimary anchors held stable across blocks. Random selection replaced.
 *   6 — bro_split fixed rotation now ROLLS across weeks via dayIndexOffset
 *       (was: stable weekly template keyed on in-week index only). A user with
 *       trainingDays < dayTypes.length (e.g. 3 days/week bro_split) used to
 *       be structurally unable to reach arms or legs; the rolling phase
 *       walks the full template over the mesocycle. inWeekStartIndex is now
 *       a no-op for fixed splits; dayIndexOffset is the canonical phase param
 *       across all rotations. Old future rows rebuild on next app open.
 *   7 — goal-aware doses: reps / rest / sets are now shaped by profiles.goal
 *       (strength / muscle / general) via src/lib/goalProfile.ts. Every
 *       exercise is written with the lane's rep band and rest, per its
 *       catalog `movement` classification (compound vs isolation). Muscle
 *       and general isolations also gain +1 set in block weeks 2-3
 *       (volume-first progression); strength stays flat and progresses via
 *       load (see loadPrescription's top-of-band gate). Deload stacks on
 *       top of the goal dose unchanged. Existing future rows regenerate on
 *       next app open — the output change is intentional and deliberately
 *       differentiates lanes that used to be identical.
 *   8 — principled goal-aware STRUCTURE + progressive volume ramp for the
 *       strength and muscle lanes. src/lib/planRules.ts replaces the
 *       hardcoded SPLIT_RULES.exerciseRules tables when goal ∈ {strength,
 *       muscle}: slot count, compound:isolation ratio, and per-slot sets
 *       are derived from four small data tables (weekly-peak sets,
 *       per-muscle session cap, compound ratio, whole-session cap). Volume
 *       ramps ACROSS the 4-week block on the muscle lane: wk1 = peak-2,
 *       wk2 = peak-1, wk3 = MAV peak, wk4 = deload of the peak — the ramp
 *       lives on isolation slots so heavy compound anchors stay flat.
 *       Strength stays flat within the block and progresses via load.
 *       GENERAL is UNTOUCHED — the SPLIT_RULES path is unchanged for that
 *       lane, so existing/default users see no output change. Determinism
 *       is preserved by construction: slot IDENTITY (count, compound
 *       ordering) is fixed within a block, so the seeded picker still
 *       returns identical EXERCISES for weeks 1–3. Also stamps
 *       PlanDay.blockWeek for the coach to speak to the ramp phase.
 *   9 — earned-deload gate: calendar week-4 no longer auto-materializes as
 *       a deload. Every plan-writing path (planSync main loop, self-heal
 *       canonical derivation, resume/catch-up pack) now funnels its
 *       (blockIndex, blockWeek) computation through
 *       src/lib/blockPosition.ts::resolveBlockPosition, which reads
 *       completed non-recovery sessions in the current block's weeks 1–3.
 *       Below DELOAD_EARN_FLOOR (3) the calendar wk4 resets to
 *       (blockIndex+1, 1) — a fresh block with base volume, not a phantom
 *       recovery week the user never trained into. Trained blocks pass
 *       through unchanged so real deloads still land. Existing rows
 *       written by v8 that materialized an unearned deload regenerate to
 *       the corrected non-deload week on next open (future rows fail the
 *       version-based satisfaction check; the active row fails the
 *       self-heal derivation because the canonical shape now differs).
 */
export const CURRENT_PLAN_VERSION = 9;

export type FitnessLevel = 'beginner' | 'intermediate' | 'advanced';
export type Location = 'gym' | 'home';
export type SplitId = 'full_body' | 'upper_lower' | 'ppl' | 'bro_split';

export interface PlanExercise {
  name: string;
  equipment: string;
  primaryMuscle: string;
  sets: number;
  reps: string;
  restSeconds: number;
  imageUrl: string;
  /** Optional sub-region emphasis carried from the catalog through
   *  weekly_plans → workout state → MuscleDetails. Undefined for entries
   *  in old plan rows written before this field existed — those fall
   *  back to the primaryMuscle's default slug in MuscleDetails, which is
   *  byte-for-byte the pre-emphasis render. */
  emphasis?: import('../constants/exercises').ExerciseEntry['emphasis'];
}

export interface PlanDay {
  day: string;
  /**
   * Calendar date this workout was placed on, YYYY-MM-DD local.
   * Source of truth for "when is this workout supposed to happen."
   *
   * generatePlan always sets this. Older plans persisted before this field
   * existed may omit it; consumers (resolvePlanDayForDate, monthCalendar)
   * fall back to weekStart + WEEKDAY_OFFSET[day] when missing. Falling
   * back can fabricate a date earlier than the plan creation day for
   * mid-week onboarders — the phantom-missed bug this field exists to fix.
   */
  date?: string;
  location: Location;
  workoutType: string;
  muscleGroups: string[];
  exercises: PlanExercise[];
  /** True when this day is part of a deload week (week 4 of the user's
   *  current 4-week mesocycle block). Working sets are reduced and the rep
   *  range bumps up. UI surfaces this so the user knows to back off and
   *  recover; the coach uses it to suppress aggressive progression copy.
   *  Optional so older stored plans (pre-v4) deserialize cleanly. */
  deload?: boolean;
  /** In-block week position (1..4) this day belongs to. Set for strength
   *  and muscle lanes so the coach can speak to the volume-ramp phase
   *  (intro / build / peak / deload). Omitted for the general lane and for
   *  stored pre-v8 rows — consumers treat undefined as "unknown phase, no
   *  ramp-specific copy" and fall through to the pre-v8 voice. Strictly
   *  redundant with `deload` when blockWeek === 4, but the field carries
   *  more information for weeks 1–3 which is otherwise indistinguishable. */
  blockWeek?: BlockWeek;
}

// ── Split rules — full mapping from (split, dayType, location, level) ─

const SPLIT_RULES = {
  full_body: {
    name: 'Full Body',
    rotation: 'same',
    dayTypes: ['full_body'],
    exerciseRules: {
      full_body: {
        gym: {
          beginner: { total: 5, structure: ['quads:1', 'chest:1', 'back:1', 'shoulders:1', 'hamstrings:1'] },
          intermediate: { total: 6, structure: ['quads:1', 'chest:1', 'back:1', 'shoulders:1', 'hamstrings:1', 'biceps:1'] },
        },
        home: {
          beginner: { total: 4, structure: ['quads:1', 'chest:1', 'back:1', 'shoulders:1'] },
          intermediate: { total: 5, structure: ['quads:1', 'chest:1', 'back:1', 'shoulders:1', 'glutes:1'] },
        },
      },
    },
  },
  upper_lower: {
    name: 'Upper / Lower',
    rotation: 'alternating',
    dayTypes: ['upper', 'lower'],
    exerciseRules: {
      upper: {
        gym: {
          beginner: { total: 5, structure: ['chest:2', 'back:2', 'shoulders:1'] },
          intermediate: { total: 6, structure: ['chest:2', 'back:2', 'shoulders:1', 'arms:1'] },
        },
        home: {
          beginner: { total: 4, structure: ['chest:2', 'back:1', 'shoulders:1'] },
          intermediate: { total: 5, structure: ['chest:2', 'back:1', 'shoulders:1', 'triceps:1'] },
        },
      },
      lower: {
        gym: {
          beginner: { total: 5, structure: ['quads:2', 'hamstrings:1', 'glutes:1', 'calves:1'] },
          intermediate: { total: 5, structure: ['quads:2', 'hamstrings:2', 'glutes:1', 'calves:1'] },
        },
        home: {
          beginner: { total: 4, structure: ['quads:2', 'glutes:1', 'calves:1'] },
          intermediate: { total: 5, structure: ['quads:2', 'hamstrings:1', 'glutes:1', 'calves:1'] },
        },
      },
    },
  },
  ppl: {
    name: 'Push Pull Legs',
    rotation: 'cycle',
    dayTypes: ['push', 'pull', 'legs'],
    exerciseRules: {
      push: {
        gym: {
          beginner: { total: 5, structure: ['chest:2', 'shoulders:2', 'triceps:1'] },
          intermediate: { total: 5, structure: ['chest:2', 'shoulders:2', 'triceps:1'] },
        },
        home: {
          beginner: { total: 4, structure: ['chest:2', 'shoulders:1', 'triceps:1'] },
          intermediate: { total: 5, structure: ['chest:2', 'shoulders:2', 'triceps:1'] },
        },
      },
      pull: {
        gym: {
          beginner: { total: 5, structure: ['back:3', 'rear delts:1', 'biceps:1'] },
          intermediate: { total: 5, structure: ['back:2', 'rear delts:1', 'biceps:2'] },
        },
        home: {
          beginner: { total: 3, structure: ['back:2', 'biceps:1'] },
          intermediate: { total: 4, structure: ['back:2', 'rear delts:1', 'biceps:1'] },
        },
      },
      legs: {
        gym: {
          beginner: { total: 5, structure: ['quads:2', 'hamstrings:1', 'glutes:1', 'calves:1'] },
          intermediate: { total: 5, structure: ['quads:2', 'hamstrings:2', 'glutes:1', 'calves:1'] },
        },
        home: {
          beginner: { total: 4, structure: ['quads:2', 'glutes:1', 'calves:1'] },
          intermediate: { total: 5, structure: ['quads:2', 'hamstrings:1', 'glutes:1', 'calves:1'] },
        },
      },
    },
  },
  bro_split: {
    name: 'Bro Split',
    rotation: 'fixed',
    dayTypes: ['chest', 'back', 'shoulders', 'arms', 'legs'],
    dropOrder: ['arms', 'shoulders'],
    exerciseRules: {
      chest: {
        gym: {
          beginner: { total: 5, structure: ['chest:4', 'triceps:1'], lastMuscle: 'triceps' },
          intermediate: { total: 5, structure: ['chest:4', 'triceps:1'], lastMuscle: 'triceps' },
        },
        home: {
          beginner: { total: 4, structure: ['chest:3', 'triceps:1'], lastMuscle: 'triceps' },
          intermediate: { total: 5, structure: ['chest:4', 'triceps:1'], lastMuscle: 'triceps' },
        },
      },
      back: {
        gym: {
          beginner: { total: 5, structure: ['back:3', 'rear delts:1', 'biceps:1'], lastMuscle: 'biceps' },
          intermediate: { total: 5, structure: ['back:3', 'rear delts:1', 'biceps:1'], lastMuscle: 'biceps' },
        },
        home: {
          beginner: { total: 3, structure: ['back:2', 'biceps:1'], lastMuscle: 'biceps' },
          intermediate: { total: 4, structure: ['back:3', 'biceps:1'], lastMuscle: 'biceps' },
        },
      },
      shoulders: {
        gym: {
          beginner: { total: 4, structure: ['shoulders:3', 'rear delts:1'] },
          intermediate: { total: 5, structure: ['shoulders:3', 'rear delts:2'] },
        },
        home: {
          beginner: { total: 3, structure: ['shoulders:2', 'triceps:1'] },
          intermediate: { total: 4, structure: ['shoulders:3', 'triceps:1'] },
        },
      },
      arms: {
        gym: {
          beginner: { total: 5, structure: ['biceps:2', 'triceps:3'] },
          intermediate: { total: 6, structure: ['biceps:3', 'triceps:3'] },
        },
        home: {
          beginner: { total: 4, structure: ['biceps:2', 'triceps:2'] },
          intermediate: { total: 5, structure: ['biceps:2', 'triceps:3'] },
        },
      },
      legs: {
        gym: {
          beginner: { total: 5, structure: ['quads:2', 'hamstrings:1', 'glutes:1', 'calves:1'] },
          intermediate: { total: 6, structure: ['quads:2', 'hamstrings:2', 'glutes:1', 'calves:1'] },
        },
        home: {
          beginner: { total: 4, structure: ['quads:2', 'glutes:1', 'calves:1'] },
          intermediate: { total: 5, structure: ['quads:2', 'hamstrings:1', 'glutes:1', 'calves:1'] },
        },
      },
    },
  },
} as const;

const DAY_TYPE_LABELS: Record<string, string> = {
  full_body: 'Full Body',
  upper: 'Upper',
  lower: 'Lower',
  push: 'Push',
  pull: 'Pull',
  legs: 'Legs',
  chest: 'Chest',
  back: 'Back',
  shoulders: 'Shoulders',
  arms: 'Arms',
};

const MUSCLE_GROUP_LABELS: Record<string, string> = {
  quads: 'Quads',
  chest: 'Chest',
  back: 'Back',
  shoulders: 'Shoulders',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  biceps: 'Biceps',
  triceps: 'Triceps',
  'rear delts': 'Rear Delts',
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Public helpers ────────────────────────────────────────────────────

/**
 * Map weekly training-days count to a default preferred_split.
 * Matches the convention already documented in CLAUDE.md.
 */
export function splitForDays(days: number): SplitId {
  if (days <= 1) return 'full_body';
  if (days === 2) return 'upper_lower';
  if (days <= 4) return 'ppl';
  return 'bro_split';
}

/**
 * Inverse of splitForDays: given a saved preferred_split, return the
 * canonical training-days count that produced it. Used to recover from
 * profiles where training_days got nulled out but preferred_split survived,
 * so we can keep generating instead of bricking the account.
 */
export function trainingDaysForSplit(split: SplitId): number {
  switch (split) {
    case 'full_body':   return 1;
    case 'upper_lower': return 2;
    case 'ppl':         return 3;
    case 'bro_split':   return 5;
  }
}

/** Every split id the generator understands. The runtime guard below uses this
 *  so a garbage `preferred_split` (corrupt profile, legacy enum) can never
 *  crash plan generation — it falls back to the days-derived default. */
const VALID_SPLITS: ReadonlySet<string> = new Set<SplitId>([
  'full_body', 'upper_lower', 'ppl', 'bro_split',
]);

/** Resolve the effective split for generation: the user's explicit pick when
 *  it's a real split, otherwise the sensible days-derived default. Keeps
 *  generatePlan crash-proof for any (split, days) combination. */
export function resolveSplit(split: SplitId | undefined | null, trainingDays: number): SplitId {
  if (split && VALID_SPLITS.has(split)) return split;
  return splitForDays(trainingDays);
}

/**
 * Maps the most recently COMPLETED session's stored workout_type (the
 * capitalized DAY_TYPE_LABELS value written to workout_sessions.workout_type
 * — "Legs", "Arms", etc., not the internal lowercase dayType key) to the
 * rotation phase for the user's NEXT session: lastTypeIndex + 1.
 *
 * This replaces the fragile "lifetime completed-session count" proxy that
 * ackGap('resume') used to pass straight through as dayIndexOffset — a raw
 * count drifts on any ad-hoc session, split change, or un-counted
 * completion, and lands on dayTypes[0] (chest, for bro_split) whenever it
 * happens to be a multiple of dayTypes.length or reads 0. Reading the
 * actual last type is exact regardless of how the count got there.
 *
 * Returns null when there's nothing to resolve from — no last completed
 * session (true cold start), or a type that doesn't belong to the
 * RESOLVED split's dayTypes (the user changed splits since that session,
 * or it was an ad-hoc/off-template workout). Callers should fall back to
 * the count-based phase in that case.
 */
export function nextRotationPhase(args: {
  split?: SplitId | null;
  trainingDays: number;
  lastWorkoutType?: string | null;
}): number | null {
  if (!args.lastWorkoutType) return null;
  const splitId = resolveSplit(args.split ?? undefined, args.trainingDays);
  const dayTypes = SPLIT_RULES[splitId].dayTypes as readonly string[];
  const idx = dayTypes.findIndex(dt => (DAY_TYPE_LABELS[dt] ?? dt) === args.lastWorkoutType);
  return idx === -1 ? null : idx + 1;
}

// ── Ad-hoc single-day generation ──────────────────────────────────────
// Used by the "Train anyway" affordance on the rest-day / no-plan error
// screen. Builds a single PlanDay of a user-chosen workout type so the rest
// of the workout flow (logging, prescriptions, recap, PR detection) can run
// unchanged — same exercise_logs, same workout_sessions, same coach lines.

export type AdHocWorkoutType =
  | 'Push'
  | 'Pull'
  | 'Legs'
  | 'Upper'
  | 'Lower'
  | 'Full Body';

interface AdHocConfig {
  trainingDays: number;
  dayIndexOffset: number;
}

// Each ad-hoc type maps to a (split, day-in-rotation) pair the generator
// already understands. Reusing generatePlan means selection seeding,
// compound-first ordering, and the lastMuscle pin are all inherited — we
// never reimplement them.
const AD_HOC_CONFIGS: Record<AdHocWorkoutType, AdHocConfig> = {
  // PPL split (3 days/week) — cycleIndex picks Push/Pull/Legs in that order,
  // so dayIndexOffset directly selects which one we generate.
  'Push':      { trainingDays: 3, dayIndexOffset: 0 },
  'Pull':      { trainingDays: 3, dayIndexOffset: 1 },
  'Legs':      { trainingDays: 3, dayIndexOffset: 2 },
  // Upper/Lower (2 days/week) — alternating rotation, same offset → dayType.
  'Upper':     { trainingDays: 2, dayIndexOffset: 0 },
  'Lower':     { trainingDays: 2, dayIndexOffset: 1 },
  // Full-body (1 day/week) — only one dayType, offset irrelevant.
  'Full Body': { trainingDays: 1, dayIndexOffset: 0 },
};

/** Build a single PlanDay for an ad-hoc workout the user chose by type.
 *  Returns null only for an unknown workout type (defensive — TypeScript
 *  rules out the case at compile time). The returned day looks identical
 *  to a planned day, so downstream finishWorkout / coach lines / PR logic
 *  don't need to know it was ad-hoc. */
export function generateAdHocDay(args: {
  workoutType: AdHocWorkoutType;
  location: Location;
  fitnessLevel: FitnessLevel;
  /** Optional — propagated to the seeded PRNG so an ad-hoc Push on a user
   *  who's in block 2 of their mesocycle gets the block-2 exercise selection
   *  for that day. Default 0. */
  blockIndex?: number;
  /** Local YYYY-MM-DD; defaults to today inside generatePlan. */
  startDate?: string;
  /** User's training goal (profiles.goal). When omitted the ad-hoc day
   *  falls back to catalog reps/rest/sets — same back-compat contract as
   *  generatePlan. */
  goal?: Goal;
}): PlanDay | null {
  const cfg = AD_HOC_CONFIGS[args.workoutType];
  if (!cfg) return null;
  const plan = generatePlan({
    fitnessLevel: args.fitnessLevel,
    trainingDays: cfg.trainingDays,
    location: args.location,
    weeksAhead: 1,
    selectedDayOffsets: [0],
    dayIndexOffset: cfg.dayIndexOffset,
    blockIndex: args.blockIndex ?? 0,
    startDate: args.startDate,
    goal: args.goal,
  });
  return plan[0] ?? null;
}

/**
 * Monday of the current week, YYYY-MM-DD, local timezone.
 */
export function currentWeekStart(): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = today.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diffToMonday);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

// ── Internal — compound-vs-isolation classifier ───────────────────────
// Convention: heavier compound movements first (when you're fresh),
// isolation/accessory last (when you're fatigued). Score is a relative
// rank only — sort DESC within each muscle group.
//
// Keywords are checked against the lowercased exercise name. Order matters:
// isolation suffixes are caught first because "Romanian Deadlift" should
// score as compound, but "Leg Extension" should not.

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

export function classifyCompoundness(name: string): number {
  const n = ' ' + name.toLowerCase() + ' ';

  // Isolation wins first: catches "Leg Extension", "Lateral Raise",
  // "Cable Fly", "Bicep Curl", etc.
  for (const k of ISOLATION_KEYWORDS) {
    if (n.includes(k)) return 2;
  }

  // Heavy compounds — the big lifts.
  for (const k of HEAVY_COMPOUND_KEYWORDS) {
    if (n.includes(k)) return 10;
  }

  // Lighter compounds — DB rows, machine press, push-ups, etc.
  for (const k of COMPOUND_KEYWORDS) {
    if (n.includes(k)) return 7;
  }

  // Default: assume mid-tier.
  return 5;
}

/**
 * True for "compound enough to tolerate a 5% per-session jump."
 * Used by loadPrescription to size the progression step. Threshold ≥ 7 means
 * heavy compounds (10) and lighter compounds (7) qualify; isolations (2) and
 * mid-tier defaults (5) do not.
 */
export function isCompoundName(name: string): boolean {
  return classifyCompoundness(name) >= 7;
}

// ── Internal — seeded PRNG for mesocycle determinism ──────────────────
// We need (blockIndex, dayType, muscle) → a reproducible exercise order so
// weeks within a 4-week block return identical lifts (the substrate for
// progressive overload + the load-prescription coach's history). Math.random
// shuffles cannot do that. mulberry32 + a tiny FNV-1a hash give us a
// per-call PRNG that's deterministic, ~10 lines, no dependency.

/** FNV-1a 32-bit string hash. Stable across JS engines; not cryptographic. */
function hashStr(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, well-distributed for our shuffle needs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the PRNG that drives selection for one (block, dayType, muscle)
 *  bucket. Slot position within the bucket is implicit in the take-order
 *  of the seeded shuffle — same bucket ⇒ same first/second/third exercise. */
function makeRand(blockIndex: number, dayType: string, muscle: string): () => number {
  return mulberry32(hashStr(`b${blockIndex}|d${dayType}|m${muscle}`));
}

/** Fisher–Yates shuffle in place using the supplied PRNG. */
function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Deload dose adjustments ───────────────────────────────────────────
// Deload weeks (blockWeek === 4) keep the same exercises as weeks 1–3 of
// the block — that's what makes the data comparable for the autoregulator
// — but cut volume and signal lighter loads. The dose change is small and
// purely arithmetic so the contract is testable from a fixture.
//
//   sets: ceil(sets * 0.6), floor 1
//     - 5 → 3   (40% volume cut)
//     - 4 → 3   (25%)
//     - 3 → 2   (33%)
//     - 2 → 2
//     - 1 → 1
//   reps: numeric "X-Y" → "X+2-Y+2"; "N" → "N+2"; anything else unchanged
//     - "6-8"    → "8-10"
//     - "10"     → "12"
//     - "AMRAP"  → "AMRAP" (left alone — caller decides what light means)

export function deloadSets(sets: number): number {
  if (!Number.isFinite(sets) || sets <= 0) return 1;
  return Math.max(1, Math.ceil(sets * 0.6));
}

export function deloadReps(reps: string | number | undefined): string | number | undefined {
  if (reps == null) return reps;
  if (typeof reps === 'number') return reps + 2;
  const range = reps.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (range) return `${parseInt(range[1], 10) + 2}-${parseInt(range[2], 10) + 2}`;
  const single = reps.match(/^\s*(\d+)\s*$/);
  if (single) return String(parseInt(single[1], 10) + 2);
  return reps;
}

// ── Internal — exercise selection ─────────────────────────────────────

// ── Major-muscle list for the "guarantee a compound" rule ─────────────
// Triceps / biceps / calves / abs / rear delts are deliberately excluded —
// their best work is isolation (see info/exercise-ranking.md). For those
// muscles, pure score rank wins.
const MAJOR_MUSCLES_NEED_COMPOUND: ReadonlySet<string> = new Set([
  'chest', 'back', 'shoulders', 'quads', 'hamstrings', 'glutes',
]);

/** True if the exercise name is a horizontal pull (row variant). Used
 *  only by the back-special compound guarantee. Inverted Row counts. */
function isHorizontalPull(name: string): boolean {
  return /\brow\b/i.test(name);
}
/** True if the exercise name is a vertical pull (pulldown / pull-up /
 *  chin-up). Used only by the back-special compound guarantee. */
function isVerticalPull(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('pulldown') ||
    n.includes('pull-up') ||
    n.includes('pullup') ||
    n.includes('pull up') ||
    n.includes('chin');
}

/** Score-ranked selection with PRIMARY-aware variety.
 *
 *  Rules:
 *   1. Primary sort key: catalog `score` DESCENDING.
 *   2. Among EQUAL scores, push non-primary recently-used candidates back
 *      (variety). isPrimary candidates are never deprioritized — they're
 *      progression anchors and must hold across blocks.
 *   3. Final tie-break: seeded PRNG draw, so a given block returns the
 *      same picks for all 4 weeks of the block (mesocycle determinism).
 *
 *  The previous implementation tied on variety+random which routinely
 *  picked two flyes for a chest slot. This function fixes that by ranking
 *  on score first.
 */
function rankCandidates(
  candidates: typeof EXERCISES,
  rand: () => number,
  planHistory?: { exercises: string[] }[],
  deprioritizeNames?: Set<string>,
): typeof EXERCISES {
  // Variety buckets — only matter as a tie-breaker for non-primary picks.
  const lastWeekNames = new Set<string>();
  const recentNames = new Set<string>();
  const olderNames = new Set<string>();
  if (planHistory && planHistory.length > 0) {
    for (const n of planHistory.slice(0, 1).flatMap(w => w.exercises)) lastWeekNames.add(n);
    for (const n of planHistory.slice(0, 2).flatMap(w => w.exercises)) recentNames.add(n);
    for (const n of planHistory.slice(2, 4).flatMap(w => w.exercises)) olderNames.add(n);
  }

  /** Higher = "fresher". 3 = never seen, 2 = older only, 1 = recent but not
   *  last week, 0 = last week. Primary exercises always get the freshest
   *  score so they sort to the top within their score tier. */
  function freshness(ex: typeof EXERCISES[number]): number {
    if (ex.isPrimary) return 3;
    if (!lastWeekNames.has(ex.name) && !recentNames.has(ex.name) && !olderNames.has(ex.name)) return 3;
    if (!lastWeekNames.has(ex.name) && !recentNames.has(ex.name) && olderNames.has(ex.name)) return 2;
    if (!lastWeekNames.has(ex.name)) return 1;
    return 0;
  }

  // Deprioritize set — same rule: never push a primary back.
  function deprio(ex: typeof EXERCISES[number]): number {
    if (ex.isPrimary) return 0;
    return deprioritizeNames?.has(ex.name) ? 1 : 0;
  }

  const annotated = candidates.map(ex => ({
    ex,
    score: ex.score,
    freshness: freshness(ex),
    deprio: deprio(ex),
    tie: rand(),
  }));

  // Sort: score DESC, then deprio ASC (front-load non-deprio),
  // then freshness DESC, then seeded tie-break ASC.
  annotated.sort((a, b) =>
    (b.score - a.score) ||
    (a.deprio - b.deprio) ||
    (b.freshness - a.freshness) ||
    (a.tie - b.tie)
  );
  return annotated.map(a => a.ex);
}

/** After top-N selection, force a compound into the slot for major muscles
 *  (chest, back, shoulders, quads, hamstrings, glutes) when count >= 2. If
 *  the top picks are all isolations, swap the lowest-ranked selected
 *  isolation for the highest-score eligible compound from the candidate
 *  pool. Back also requires one horizontal + one vertical pull.
 *
 *  No-op for muscles outside MAJOR_MUSCLES_NEED_COMPOUND — their best
 *  work is isolation (curls, pushdowns, lateral raise, crunches, calf
 *  raises) and pure score rank is correct. */
function ensureCompound(
  muscle: string,
  picked: typeof EXERCISES,
  ranked: typeof EXERCISES,
  count: number,
): typeof EXERCISES {
  if (count < 2) return picked;
  if (!MAJOR_MUSCLES_NEED_COMPOUND.has(muscle)) return picked;

  const result = [...picked];
  const pickedNames = new Set(result.map(e => e.name));

  // Back special: guarantee BOTH a horizontal and a vertical pull.
  if (muscle === 'back') {
    const hasHorizontal = result.some(e => e.movement === 'compound' && isHorizontalPull(e.name));
    const hasVertical = result.some(e => e.movement === 'compound' && isVerticalPull(e.name));
    if (!hasHorizontal) {
      const replacement = ranked.find(e =>
        e.movement === 'compound' && isHorizontalPull(e.name) && !pickedNames.has(e.name),
      );
      if (replacement) {
        // Swap the lowest-score picked exercise that isn't already the
        // (sole) vertical we're trying to preserve.
        const isProtected = (e: typeof EXERCISES[number]) =>
          hasVertical && e.movement === 'compound' && isVerticalPull(e.name);
        for (let i = result.length - 1; i >= 0; i--) {
          if (!isProtected(result[i])) { result.splice(i, 1); break; }
        }
        result.push(replacement);
        pickedNames.delete(/* placeholder; rebuild */ '');
        pickedNames.clear();
        for (const e of result) pickedNames.add(e.name);
      }
    }
    if (!hasVertical) {
      const replacement = ranked.find(e =>
        e.movement === 'compound' && isVerticalPull(e.name) && !pickedNames.has(e.name),
      );
      if (replacement) {
        const isProtected = (e: typeof EXERCISES[number]) =>
          e.movement === 'compound' && isHorizontalPull(e.name);
        for (let i = result.length - 1; i >= 0; i--) {
          if (!isProtected(result[i])) { result.splice(i, 1); break; }
        }
        result.push(replacement);
      }
    }
    return result;
  }

  // Other major muscles: just need at least one compound.
  if (result.some(e => e.movement === 'compound')) return result;
  const replacement = ranked.find(e => e.movement === 'compound' && !pickedNames.has(e.name));
  if (!replacement) return result;
  // Drop the lowest-ranked isolation (last in the picked array — ranking
  // is score DESC, so the tail is the weakest pick).
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].movement === 'isolation') { result.splice(i, 1); break; }
  }
  result.push(replacement);
  return result;
}

function pickExercises(
  muscleGroup: string,
  location: string,
  level: string,
  count: number,
  usedNames: Set<string>,
  rand: () => number,
  planHistory?: { exercises: string[] }[],
  deprioritizeNames?: Set<string>,
): typeof EXERCISES {
  // Beginner / Intermediate are real difficulty levels; advanced falls back
  // to intermediate selection (we don't have a separate "advanced" tier in
  // the exercise library).
  const lookupLevel = level === 'advanced' ? 'intermediate' : level;

  const candidates = EXERCISES.filter(e =>
    e.primaryMuscle === muscleGroup &&
    e.location.includes(location) &&
    e.difficulty.includes(lookupLevel) &&
    !usedNames.has(e.name)
  );

  const ranked = rankCandidates(candidates, rand, planHistory, deprioritizeNames);
  const picked = ranked.slice(0, count);
  return ensureCompound(muscleGroup, picked, ranked, count);
}

// ── Public — generate a full week of PlanDays ─────────────────────────

export interface GeneratePlanArgs {
  fitnessLevel: FitnessLevel;
  trainingDays: number;
  location: Location;
  /** The user's chosen workout split (profiles.preferred_split). This is now an
   *  EXPLICIT choice, not a function of trainingDays — the user can pick a split
   *  that doesn't match their day count (e.g. bro_split with 2 days). When
   *  omitted (or invalid), falls back to splitForDays(trainingDays) so every
   *  existing caller/test keeps its prior behavior. The day COUNT still comes
   *  from trainingDays/selectedDayOffsets; `split` only chooses which dayTypes
   *  rotate through those days. */
  split?: SplitId;
  /** Optional: pre-pick which weekday offsets (0..6 from today) are training days.
   *  When omitted, we pick the first N consecutive days starting today,
   *  but never more than 3 in a row (insert rest days). */
  selectedDayOffsets?: number[];
  /** Optional: last 4 weeks of plans for variety scoring. */
  planHistory?: { exercises: string[] }[];
  /** Number of consecutive 7-day weeks to generate (default 1). When >1, the
   *  result is a flat PlanDay[] spanning weeksAhead*trainingDays entries with
   *  monotonically increasing .date. Rotation continues across week
   *  boundaries (PPL keeps cycling, upper/lower keeps alternating, bro split
   *  keeps its sequence) — it does NOT reset at each week. The usedExerciseNames
   *  set DOES reset per week so consecutive weeks aren't empty by exhaustion
   *  (the variety nudge across weeks still comes from planHistory). */
  weeksAhead?: number;
  /** Rotation phase offset, used when topping up partial coverage so PPL/
   *  bro-split cycles resume where the prior generation left off. Set to
   *  (trainingDays * fully-generated-weeks-before-this-call). Default 0. */
  dayIndexOffset?: number;
  /** YYYY-MM-DD local date that offset 0 anchors to. Default = today. Used by
   *  ensureCurrentWeekPlan to generate weeks starting at a future Monday-ish
   *  anchor (today+7, +14, +21) without faking "now". */
  startDate?: string;
  /** Mesocycle block this generation belongs to. A "block" is 4 consecutive
   *  weeks that share the same lifts (so progressive overload can accumulate
   *  history per exercise). Exercise selection is seeded on
   *  (blockIndex, dayType, muscle): identical within a block, reshuffled at
   *  the block boundary. Default 0. ensureCurrentWeekPlan computes this from
   *  the user's plan anchor. */
  blockIndex?: number;
  /** In-block week position (1..4) of the FIRST week being generated by this
   *  call. Default 1 ("fresh block, no deload"). When the loop advances
   *  beyond a block boundary, it wraps mod 4. Week 4 within the loop is a
   *  deload week — sets reduced, reps bumped, PlanDay.deload = true.
   *  Production path (planSync.ensureCurrentWeekPlan) calls weeksAhead=1 per
   *  week and computes blockWeek from the user's plan anchor; tests that
   *  span a full block use weeksAhead=4 with blockWeek=1. */
  blockWeek?: number;
  /** For FIXED-ROTATION splits ONLY (bro_split): shift where the weekly
   *  template begins. Default 0 → template starts at dayTypes[0] (chest).
   *  Passing 2 → starts at dayTypes[2] (shoulders), then arms, legs, chest,
   *  back. Used by buildCatchUpRows so a bro_split user mid-mesocycle resumes
   *  at the correct next type instead of restarting at chest.
   *  NO-OP for cycle/alternating/same rotations — those already honor
   *  dayIndexOffset, so passing this param for PPL / upper_lower /
   *  full_body has no effect on output. Only the fixed-template lookup
   *  reads it. */
  inWeekStartIndex?: number;
  /** User's training goal (profiles.goal). Shapes per-exercise reps / rest
   *  / sets via src/lib/goalProfile.ts based on catalog.movement:
   *    - strength: heavy compound (3-5), lower-rep isolation (8-10),
   *      longer rest, sets flat across the block.
   *    - muscle:   hypertrophy compound (6-10), high-rep isolation (10-15),
   *      shorter rest, isolation sets climb in wks 2-3.
   *    - general:  BLENDED default — heavy-ish compound (5-8), growth-band
   *      isolation (10-15), moderate rest, isolation sets climb in wks 2-3.
   *  Undefined → catalog values pass through unchanged (back-compat for
   *  callers / tests that don't care about the lane). The self-heal
   *  comparison in planCatchUp only checks (date, workoutType), so a
   *  reps/rest/sets change from goal takes effect at the next week
   *  boundary without triggering an unwanted heal on already-materialized
   *  rows — same scoping as swaps and deloads. */
  goal?: Goal;
}

export function generatePlan(args: GeneratePlanArgs): PlanDay[] {
  const { fitnessLevel, trainingDays, location, planHistory, goal } = args;
  const weeksAhead = Math.max(1, Math.min(12, args.weeksAhead ?? 1));
  const dayIndexOffset = Math.max(0, args.dayIndexOffset ?? 0);
  const blockIndex = Math.max(0, args.blockIndex ?? 0);
  // Clamp blockWeek to 1..4; anything else is a caller error we silently
  // recover from by treating it as week 1 of a fresh block.
  const startBlockWeekRaw = args.blockWeek ?? 1;
  const startBlockWeek =
    startBlockWeekRaw >= 1 && startBlockWeekRaw <= 4 ? Math.floor(startBlockWeekRaw) : 1;
  // Fixed-rotation phase shift. Only consumed by the 'fixed' branch below;
  // ignored by cycle/alternating/same rotations (they advance via globalI/
  // cycleIndex/dayIndexOffset). Clamped to non-negative; values larger than
  // dayTypes.length are mod'd at the lookup site.
  const startInWeekIdx = Math.max(0, Math.floor(args.inWeekStartIndex ?? 0));
  // Split is the user's explicit choice (preferred_split), falling back to the
  // days-derived default when absent/invalid. The day COUNT still comes from
  // trainingDays via baseOffsets, so any split×days combo is supported: e.g.
  // bro_split with 2 days → chest, back; full_body with 6 days → six full-body
  // days. resolveSplit guarantees `rule` is always a valid SPLIT_RULES entry.
  const splitId = resolveSplit(args.split, trainingDays);
  const rule = SPLIT_RULES[splitId];

  const baseOffsets = args.selectedDayOffsets ?? pickDefaultDayOffsets(trainingDays);

  let anchor: Date;
  if (args.startDate) {
    const p = args.startDate.split('-').map(Number);
    anchor = new Date(p[0], p[1] - 1, p[2]);
  } else {
    const now = new Date();
    anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  const result: PlanDay[] = [];
  // globalI is the absolute training-day counter across all generated weeks
  // (continues through the dayIndexOffset given by the caller). cycleIndex is
  // its 'cycle'-rotation twin. Both advance once per training day, never reset
  // at the week boundary — that's the contract that keeps PPL cycling and the
  // bro split walking through its dayTypes/dropOrder sequence.
  let globalI = dayIndexOffset;
  let cycleIndex = dayIndexOffset;

  for (let week = 0; week < weeksAhead; week++) {
    // Reset per week: with 4 consecutive weeks and the same level/location, a
    // single shared used-set would run the exercise pool dry after week 1.
    // Cross-week variety is still nudged by planHistory's variety scoring.
    const usedExerciseNames = new Set<string>();

    // In-block week position (1..4) for this loop iteration. The deload
    // trigger is purely arithmetic — `blockWeekInLoop === 4` — so the rule
    // is fully testable from a fixed `blockWeek` input and a fixed loop
    // index, with no clock or DB dependency.
    const blockWeekInLoop = ((startBlockWeek - 1 + week) % 4) + 1;
    const isDeloadWeek = blockWeekInLoop === 4;

    for (let inWeekIdx = 0; inWeekIdx < baseOffsets.length; inWeekIdx++) {
      const offset = baseOffsets[inWeekIdx];
      const dayOffset = week * 7 + offset;
      const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + dayOffset);
      const dayName = DAY_NAMES[date.getDay()];

    let dayType: string;
    const dayTypes = rule.dayTypes as readonly string[];
    if (rule.rotation === 'same') {
      dayType = dayTypes[0];
    } else if (rule.rotation === 'alternating') {
      dayType = dayTypes[globalI % dayTypes.length];
    } else if (rule.rotation === 'cycle') {
      dayType = dayTypes[cycleIndex % dayTypes.length];
      cycleIndex++;
    } else if (rule.rotation === 'fixed') {
      // A 'fixed' split (bro_split) is a STABLE WEEKLY TEMPLATE — within a
      // single week, the muscle assigned to inWeekIdx N is deterministic.
      // Across weeks the phase ROLLS so every muscle is reached over the
      // mesocycle. Before the roll, a user with trainingDays < dayTypes.length
      // (e.g. 3 days/week on bro_split) only ever trained chest/back/shoulders
      // — arms and legs were structurally unreachable because the template
      // restarted at index 0 every week.
      //
      // PHASE: `dayIndexOffset` is the canonical absolute position param,
      // identical to how cycle/alternating splits resume. `week *
      // baseOffsets.length` advances the phase by `trainingDays` per week
      // within a single multi-week call so a 3-day user walks the full 5-type
      // rotation in (5/3) weeks ≈ 2 weeks. Per-week single-call paths
      // (planSync.ensureCurrentWeekPlan) pass `dayIndexOffset =
      // completedBeforeWeek + i * trainingDays` and rely on `week === 0`
      // inside this loop, so the two paths agree.
      //
      // `inWeekStartIndex` is now a documented NO-OP for the fixed branch
      // (it used to be the only phase source). It's still accepted by
      // generatePlan for API stability; buildCatchUpRows used to pass it
      // and has been cleaned up to rely solely on dayIndexOffset. The
      // parameter is left in place to avoid breaking any external caller.
      //
      // dropOrder supplies the extra day(s) when training days exceed
      // dayTypes.length (bro_split with 6–7 days/week). It is NOT phase-
      // shifted — dropOrder is a deterministic 6th/7th-day filler whose
      // semantics ("repeat arms then shoulders") don't depend on the
      // rotation phase.
      const dropOrder = (rule as any).dropOrder as string[] | undefined;
      if (inWeekIdx >= dayTypes.length && dropOrder && dropOrder.length > 0) {
        dayType = dropOrder[(inWeekIdx - dayTypes.length) % dropOrder.length];
      } else {
        const phase = dayIndexOffset + week * baseOffsets.length;
        dayType = dayTypes[(inWeekIdx + phase) % dayTypes.length];
      }
    } else {
      dayType = dayTypes[0];
    }

    globalI++;

    const exercises: PlanExercise[] = [];
    const muscleGroups: string[] = [];

    // ── Engine-lane branch: strength / muscle route through planRules ──
    // planRules produces a principled slot list (compound:isolation ratio,
    // ramped sets per week). Only fires when goal is strength/muscle AND
    // the (split, dayType) is engine-mapped in DAY_TYPE_MUSCLES. Everything
    // else falls through to the SPLIT_RULES path below — that path is the
    // ONLY thing the general lane ever sees, so `goal === 'general'` users
    // get byte-identical output to v7.
    const engineLane: 'strength' | 'muscle' | null =
      goal === 'strength' || goal === 'muscle' ? goal : null;
    const engineStructure: DayStructure | null = engineLane
      ? buildDayStructure({
          goal: engineLane,
          dayType,
          location,
          level: fitnessLevel,
          split: splitId,
          trainingDays,
        })
      : null;

    if (engineStructure) {
      // Engine path. planRules gave us an ordered list of muscles + slots;
      // for each muscle we call pickExercises with the total slot count
      // (compounds guaranteed by ensureCompound for majors, sorted
      // compound-first by classifyCompoundness), then MAP the returned
      // exercises 1:1 onto the slots. Compound-first sort in the picker
      // aligns with slots' compound-first ordering out of planRules.
      for (const group of engineStructure.muscles) {
        const muscle = group.muscle;
        const slots: MuscleSlot[] = group.slots;
        const count = slots.length;
        if (count === 0) continue;

        const rand = makeRand(blockIndex, dayType, muscle);
        const picked = pickExercises(muscle, location, fitnessLevel, count, usedExerciseNames, rand, planHistory);
        if (picked.length < count) {
          const fallback = EXERCISES.filter(e =>
            e.primaryMuscle === muscle &&
            e.location.includes(location) &&
            e.difficulty.includes(fitnessLevel === 'advanced' ? 'intermediate' : fitnessLevel)
          );
          const remaining = fallback.filter(e => !usedExerciseNames.has(e.name));
          picked.push(...(remaining.length > 0 ? remaining : fallback).slice(0, count - picked.length));
        }

        // Within-muscle compound-first sort (matches slot ordering).
        picked.sort((a, b) => classifyCompoundness(b.name) - classifyCompoundness(a.name));

        for (let i = 0; i < picked.length; i++) {
          const ex = picked[i];
          const slot = slots[i];
          usedExerciseNames.add(ex.name);
          // Reps and rest still flow through goalReps / goalRest as v7 —
          // planRules owns SETS only, not the load-side dose. Deload adds
          // +2 reps on wk4 same as before (planRules' setsByWeek[4] is the
          // already-deloaded set count, so no double-deload on sets).
          const compound = ex.movement === 'compound';
          const gReps = goalReps(ex.reps, goal, compound);
          const gRest = goalRest(ex.restSeconds, goal, compound);
          const sets = slot.setsByWeek[blockWeekInLoop as BlockWeek];
          const reps = isDeloadWeek ? (deloadReps(gReps) as string) : gReps;
          exercises.push({
            name: ex.name,
            equipment: ex.equipment,
            primaryMuscle: MUSCLE_GROUP_LABELS[muscle] || muscle,
            sets,
            reps,
            restSeconds: gRest,
            imageUrl: ex.imageUrl,
            emphasis: ex.emphasis,
          });
        }

        const label = MUSCLE_GROUP_LABELS[muscle] || muscle;
        if (!muscleGroups.includes(label)) muscleGroups.push(label);
      }
    } else {
      // Fallback path — the pre-v8 SPLIT_RULES flow. Unchanged for the
      // general lane; also handles engine-lane calls where the (split,
      // dayType) isn't engine-mapped (e.g. an unusual custom dayType).
      const rules = (rule.exerciseRules as any)[dayType];
      if (!rules) continue;
      const locationRules = rules[location];
      if (!locationRules) continue;
      const level = fitnessLevel === 'advanced' ? 'intermediate' : fitnessLevel;
      const levelRules = locationRules[level];
      if (!levelRules) continue;

      for (const entry of levelRules.structure as string[]) {
        const [muscle, countStr] = entry.split(':');
        const count = parseInt(countStr, 10);

        const rand = makeRand(blockIndex, dayType, muscle);
        const picked = pickExercises(muscle, location, fitnessLevel, count, usedExerciseNames, rand, planHistory);
        if (picked.length < count) {
          const fallback = EXERCISES.filter(e =>
            e.primaryMuscle === muscle &&
            e.location.includes(location) &&
            e.difficulty.includes(fitnessLevel === 'advanced' ? 'intermediate' : fitnessLevel)
          );
          const remaining = fallback.filter(e => !usedExerciseNames.has(e.name));
          picked.push(...(remaining.length > 0 ? remaining : fallback).slice(0, count - picked.length));
        }

        picked.sort((a, b) => classifyCompoundness(b.name) - classifyCompoundness(a.name));

        picked.forEach(ex => {
          usedExerciseNames.add(ex.name);
          // Goal-aware dose is applied FIRST, then deload stacks on top:
          //   catalog → goalReps/goalRest/goalSets → deloadReps/deloadSets
          // goalReps / goalSets pass the catalog value through unchanged
          // when goal is missing (general lane), so callers that don't set
          // goal (older tests, ad-hoc code paths pre-goal) get byte-identical
          // output.
          const compound = ex.movement === 'compound';
          const gReps = goalReps(ex.reps, goal, compound);
          const gRest = goalRest(ex.restSeconds, goal, compound);
          const gSets = goalSets(ex.sets, goal, compound, blockWeekInLoop);
          const sets = isDeloadWeek ? deloadSets(gSets) : gSets;
          const reps = isDeloadWeek ? (deloadReps(gReps) as string) : gReps;
          exercises.push({
            name: ex.name,
            equipment: ex.equipment,
            primaryMuscle: MUSCLE_GROUP_LABELS[muscle] || muscle,
            sets,
            reps,
            restSeconds: gRest,
            imageUrl: ex.imageUrl,
            emphasis: ex.emphasis,
          });
        });

        const label = MUSCLE_GROUP_LABELS[muscle] || muscle;
        if (!muscleGroups.includes(label)) muscleGroups.push(label);
      }
    }

    // Session-level reorder: across the whole day, put heaviest compounds
    // first, secondary compounds next, isolations last. Within each rank,
    // preserve the upstream order (the per-muscle compounds-first pick
    // already handled within-group ordering — this just lifts that across
    // the session). Stable sort guarantees this preservation.
    exercises.sort((a, b) => classifyCompoundness(b.name) - classifyCompoundness(a.name));

    // lastMuscle pin is a SPLIT_RULES concept (used by bro_split fallback
    // path to keep e.g. triceps at the tail of chest day). Engine-lane
    // days derive muscle ordering from DAY_TYPE_MUSCLES priority and don't
    // need a separate pin — small muscles are already last in the list.
    if (!engineStructure) {
      const rulesForPin = (rule.exerciseRules as any)[dayType];
      const locRulesForPin = rulesForPin?.[location];
      const level = fitnessLevel === 'advanced' ? 'intermediate' : fitnessLevel;
      const levelRulesForPin = locRulesForPin?.[level];
      if (levelRulesForPin?.lastMuscle && exercises.length > 0) {
        const lastMuscleLabel = MUSCLE_GROUP_LABELS[levelRulesForPin.lastMuscle] || levelRulesForPin.lastMuscle;
        const lastEx = exercises[exercises.length - 1];
        if (lastEx.primaryMuscle !== lastMuscleLabel) {
          const swapIdx = exercises.findIndex(e => e.primaryMuscle === lastMuscleLabel);
          if (swapIdx >= 0 && swapIdx !== exercises.length - 1) {
            const tmp = exercises[exercises.length - 1];
            exercises[exercises.length - 1] = exercises[swapIdx];
            exercises[swapIdx] = tmp;
          }
        }
      }
    }

    // ISO the calendar date this offset resolves to, local timezone. This is
    // the anchor: this is the day the workout is supposed to happen, and
    // every downstream consumer (missed detection, calendar, shift) should
    // read it directly rather than reconstructing from `day` + a weekStart.
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    result.push({
      day: dayName,
      date: iso,
      location,
      workoutType: DAY_TYPE_LABELS[dayType] || dayType,
      muscleGroups,
      exercises,
      // Only stamp the flag in deload weeks; leaving it undefined elsewhere
      // keeps serialized plans clean and means stored pre-v4 rows compare
      // equal to fresh v4 non-deload generations.
      ...(isDeloadWeek ? { deload: true as const } : {}),
      // Stamp blockWeek only when the day went through the engine — the
      // ramp phase is meaningful there. Fallback (general lane) days leave
      // it undefined to preserve pre-v8 output shape for existing users.
      ...(engineStructure ? { blockWeek: blockWeekInLoop as BlockWeek } : {}),
    });
    }
  }

  return result;
}

/**
 * Spread training days across the next 7 starting today, never more than 2
 * consecutive without a rest in between. Returns offsets from today (0..6).
 *
 *   1 day  → [0]
 *   2 days → [0, 3]
 *   3 days → [0, 2, 4]
 *   4 days → [0, 2, 4, 6]
 *   5 days → [0, 1, 3, 4, 6]
 *   6 days → [0, 1, 2, 4, 5, 6]
 *   7 days → [0, 1, 2, 3, 4, 5, 6]
 */
function pickDefaultDayOffsets(trainingDays: number): number[] {
  const n = Math.max(1, Math.min(7, trainingDays));
  switch (n) {
    case 1: return [0];
    case 2: return [0, 3];
    case 3: return [0, 2, 4];
    case 4: return [0, 2, 4, 6];
    case 5: return [0, 1, 3, 4, 6];
    case 6: return [0, 1, 2, 4, 5, 6];
    default: return [0, 1, 2, 3, 4, 5, 6];
  }
}
