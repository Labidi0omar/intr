// Principled goal-aware exercise structure — pure module.
//
// Replaces the hardcoded SPLIT_RULES.exerciseRules tables for the STRENGTH
// and MUSCLE lanes. The general lane keeps the existing SPLIT_RULES path
// unchanged (short-circuit in generatePlan). This module answers:
//
//   "For (goal, dayType, location, level, split, trainingDays), what
//    muscles do we train, how many exercises per muscle, which are
//    compound vs isolation, and how many sets per exercise across the
//    4-week block?"
//
// Everything is derived from four numeric tables + a per-split muscle map,
// so a tune ("bump intermediate muscle chest to 16 weekly") is a one-line
// edit — not a search-and-replace across split templates.
//
// SCOPE — what this module OWNS and what it does NOT touch:
//   OWNS:
//     - which muscles are trained on a given dayType (DAY_TYPE_MUSCLES)
//     - how many exercises per muscle (slot count)
//     - which slots are compound vs isolation (compoundHint)
//     - sets per slot at each block week (peak / wk2 / wk1 / deload)
//   DOES NOT TOUCH:
//     - exercise selection (that stays in generatePlan's picker — seeded
//       (blockIndex, dayType, muscle) PRNG → identical exercises weeks 1–3)
//     - dayType rotation (SPLIT_RULES.rotation is unchanged)
//     - day count / rest-day placement (baseOffsets is unchanged)
//     - reps / rest / deload rep bump (goalReps / goalRest / deloadReps
//       still handle the load-side dose; this module only produces the
//       volume side)
//
// DETERMINISM CONTRACT preserved by construction:
//   - Output does NOT depend on blockWeek for slot IDENTITY. Slot count,
//     compound/isolation makeup, and MUSCLE priority order are fixed within
//     a block — the ramp only varies SETS per slot week-to-week.
//   - Because the picker still keys on (blockIndex, dayType, muscle), weeks
//     1–3 of a block return byte-identical EXERCISES; only the sets number
//     changes across the ramp.
//   - Self-heal in planCatchUp compares (date, workoutType) only, so a set
//     count change never triggers a rewrite of already-materialized rows.
//
// Everything below is pure. Tests drive the corners.

import type { FitnessLevel, Location, SplitId } from './planGeneration';

// ── Muscle tiers ─────────────────────────────────────────────────────────
// Two-tier system: MAJOR muscles get the full compound:isolation ratio
// treatment; SMALL muscles stay isolation-dominant on both lanes (a strength
// plan still curls with a curl). Rear delts and calves are structural
// "small" — heavy work on them is the wrong tool.
//
// NOTE ON INDIRECT VOLUME (must not double-count):
// Direct SMALL-muscle weekly targets below (biceps/triceps 12 muscle-int,
// side/rear delts 14 muscle-adv, etc.) are DIRECT set counts. Triceps also
// eat indirect volume from every horizontal / overhead press; biceps from
// every row / pull; calves from every squat / lunge. Real EXPOSURE for those
// muscles is meaningfully above the direct number. That's correct
// programming and it's why isolation is what actually grows arms — but if
// the numbers below ever LOOK undervolumed, DO NOT bump them: the indirect
// exposure is already in the plan via the compound slots. Bumping would
// double-count.

const MAJOR_MUSCLES: ReadonlySet<string> = new Set([
  'chest', 'back', 'shoulders', 'quads', 'hamstrings', 'glutes',
]);

const SMALL_MUSCLES: ReadonlySet<string> = new Set([
  'biceps', 'triceps', 'rear delts', 'calves',
]);

export type MuscleTier = 'major' | 'small';

/** True for muscles routed through the new engine. Unknown muscles are
 *  ignored (planRules is not authoritative for them; the SPLIT_RULES path
 *  handles the general lane and any dayType-muscle we don't map). */
export function muscleTier(muscle: string): MuscleTier | null {
  if (MAJOR_MUSCLES.has(muscle)) return 'major';
  if (SMALL_MUSCLES.has(muscle)) return 'small';
  return null;
}

// ── Lane (goal ∩ engine coverage) ────────────────────────────────────────
// planRules is only authoritative for the STRENGTH and MUSCLE lanes.
// 'general' short-circuits back to SPLIT_RULES in generatePlan.

export type EngineLane = 'strength' | 'muscle';

// ── Table 1 · Weekly PEAK sets/muscle at week-3 MAV ──────────────────────
// This is the WEEK-3 PEAK, not the week-1 base. The ramp interpolates
// BACKWARD from these numbers (see rampTargetSets below). Values sit at
// or below the mainstream MRV window per muscle (chest ~20, quads ~20,
// biceps ~20 direct) so wk3 has recoverable headroom.

const WEEKLY_PEAK_SETS: Record<EngineLane, Record<FitnessLevel, Record<MuscleTier, number>>> = {
  strength: {
    beginner:     { major: 8,  small: 6 },
    intermediate: { major: 10, small: 8 },
    advanced:     { major: 12, small: 8 },
  },
  muscle: {
    beginner:     { major: 10, small: 8  },
    intermediate: { major: 14, small: 12 },
    advanced:     { major: 18, small: 14 },
  },
};

// ── Table 5 · Per-muscle-per-session cap ─────────────────────────────────
// Ceiling on sets one muscle can take in a single session. Bro-split users
// (freq=1) would otherwise get all their weekly volume dumped into one
// day; ≥ ~10 sets of one muscle in one session is diminishing-returns
// territory. When the derived session peak exceeds this cap, the excess
// SPILLS OFF (no accumulation, no phantom weekly total).
//
// Advanced strength on freq-1 splits (PPL 3-day, bro-split) has its major
// weekly target 12 SILENTLY CAPPED to 10 sets/session. That's fine: 10
// quality heavy sets is plenty of strength stimulus in one day. Case D-
// prime fixture pins this so the clamp is deliberate, not accidental.

const PER_MUSCLE_SESSION_CAP: Record<MuscleTier, number> = {
  major: 10,
  small: 8,
};

// ── Whole-session caps ───────────────────────────────────────────────────
// Ceilings on total sets AND movement count per session. Strength has a
// TIGHTER cap than muscle: heavy work at 3–5 reps with ~210s rest fits far
// fewer sets in a session than hypertrophy work at ~90s rest. 20 heavy
// working sets ≈ 60–70 min; 25 hypertrophy sets ≈ 60–75 min.
//
// The caps DO fire on approved cases — the trim path is the load-bearing
// mechanism, not a defensive fallback:
//   - Case D strength PPL 3-day push has session_peak 10 + 10 + 8 = 28
//     across 8 slots, BOTH over caps. The trim rewrites it to ≤ 20 sets
//     across 6 movements by dropping non-primary iso slots and cutting
//     iso sets — compound anchors and the primary-per-muscle slot are
//     PROTECTED so what remains is real strength stimulus, not padding.
//   - Case A muscle PPL 6-day push sits at 25 sets / 8 slots — fits the
//     muscle caps exactly, no trim.
//
// Priority (least to most protected): non-primary isolation slots → non-
// primary compound slots → primary compound anchors. The primary anchor
// per muscle (isPrimarySlot === true) and the muscle's LAST remaining
// slot are never dropped.

const WHOLE_SESSION_CAP: Record<EngineLane, number> = {
  strength: 20, // heavy sets × long rest — ~60–70 min at this ceiling
  muscle:   25, // hypertrophy pace — ~60–75 min at this ceiling
};

const MAX_MOVEMENTS: Record<EngineLane, number> = {
  strength: 6, // strength = fewer, heavier movements
  muscle:   8, // hypertrophy = more variety; Case A push sits at 8 exactly
};

// ── Table 2 · Compound : isolation ratio (major muscles only) ────────────
// Small muscles (biceps, triceps, rear delts, calves) stay ISOLATION on
// both lanes — the strength lane picks a compound anchor for a small
// muscle only when the catalog offers one that clearly belongs (close-grip
// bench for triceps, chin-up for biceps) via generatePlan's picker; the
// slot COUNT here is isolation-only for small muscles.

const COMPOUND_RATIO: Record<EngineLane, number> = {
  strength: 0.8,
  muscle:   0.5,
};

// ── DAY_TYPE_MUSCLES · which muscles get volume on which dayType ─────────
// Priority ORDER matters — earlier entries are the muscle FOCUS for the
// day and are protected during whole-session cap trims (last muscle's
// last slot is trimmed first).
//
// One muscle per day for bro-split: the pre-existing SPLIT_RULES also
// stitched biceps onto back day and triceps onto chest day as accessories.
// The new engine drops those — the split's promise IS "one muscle a day",
// and every arm muscle already gets ample DIRECT volume on arms day and
// INDIRECT exposure from press/row compounds on the other days. Adding
// direct arm accessories to chest/back would inflate session length for
// stimulus we already have.

const DAY_TYPE_MUSCLES: Record<SplitId, Record<string, readonly string[]>> = {
  full_body: {
    full_body: ['chest', 'back', 'quads', 'shoulders', 'hamstrings'],
  },
  upper_lower: {
    upper: ['chest', 'back', 'shoulders'],
    lower: ['quads', 'hamstrings', 'glutes'],
  },
  ppl: {
    push: ['chest', 'shoulders', 'triceps'],
    pull: ['back', 'rear delts', 'biceps'],
    legs: ['quads', 'hamstrings', 'glutes', 'calves'],
  },
  bro_split: {
    chest:     ['chest'],
    back:      ['back'],
    shoulders: ['shoulders', 'rear delts'],
    arms:      ['biceps', 'triceps'],
    legs:      ['quads', 'hamstrings', 'glutes', 'calves'],
  },
};

// ── Frequency computation ────────────────────────────────────────────────
// How many times per week the muscle is trained given the user's split
// AND training days. Uses the same rotation math as generatePlan so the
// two agree — a PPL 3-day user gets freq=1 for chest (push day only);
// a PPL 6-day user gets freq=2.

/** Walk one week's worth of dayTypes for the given split × trainingDays,
 *  copying generatePlan's rotation logic. Pure — no clock, no DB. */
function weekDayTypes(split: SplitId, trainingDays: number): string[] {
  // We rebuild the sequence here from the SplitId + trainingDays instead of
  // importing SPLIT_RULES to keep this module a leaf (no circular import
  // with planGeneration).
  const out: string[] = [];
  const days = Math.max(1, Math.min(7, trainingDays));

  switch (split) {
    case 'full_body':
      for (let i = 0; i < days; i++) out.push('full_body');
      return out;
    case 'upper_lower': {
      const seq: readonly string[] = ['upper', 'lower'];
      for (let i = 0; i < days; i++) out.push(seq[i % seq.length]);
      return out;
    }
    case 'ppl': {
      const seq: readonly string[] = ['push', 'pull', 'legs'];
      for (let i = 0; i < days; i++) out.push(seq[i % seq.length]);
      return out;
    }
    case 'bro_split': {
      const seq: readonly string[] = ['chest', 'back', 'shoulders', 'arms', 'legs'];
      const drop: readonly string[] = ['arms', 'shoulders']; // matches SPLIT_RULES.dropOrder
      for (let i = 0; i < days; i++) {
        if (i < seq.length) out.push(seq[i]);
        else out.push(drop[(i - seq.length) % drop.length]);
      }
      return out;
    }
  }
}

/** How many times per week `muscle` is trained given the user's split and
 *  training days. Returns 0 when the muscle never appears (planRules just
 *  won't emit slots for it — caller falls through). */
export function computeFrequency(
  split: SplitId,
  trainingDays: number,
  muscle: string,
): number {
  const dayTypes = weekDayTypes(split, trainingDays);
  let f = 0;
  for (const dt of dayTypes) {
    const muscles = DAY_TYPE_MUSCLES[split]?.[dt];
    if (muscles?.includes(muscle)) f++;
  }
  return f;
}

// ── Session peak sets (per muscle, per session, at wk3 MAV) ──────────────

/** Weekly peak sets/muscle for (lane, level, tier). Undefined for unknown
 *  goals — the caller should have already short-circuited to SPLIT_RULES. */
export function weeklyPeakSets(lane: EngineLane, level: FitnessLevel, tier: MuscleTier): number {
  return WEEKLY_PEAK_SETS[lane][level][tier];
}

/** Session-level peak sets after cap:
 *    ceil(weekly_peak / freq)  → then clamped to per-muscle-per-session cap.
 *  When the cap bites, weekly volume falls short of the table target — the
 *  "spill off" the design accepts (Case B/C bro-split with freq=1). */
export function sessionPeakSets(
  muscle: string,
  lane: EngineLane,
  level: FitnessLevel,
  freq: number,
): number {
  const tier = muscleTier(muscle);
  if (tier == null) return 0; // unknown muscle; caller skips
  if (freq <= 0) return 0;
  const weekly = weeklyPeakSets(lane, level, tier);
  const raw = Math.ceil(weekly / freq);
  return Math.min(raw, PER_MUSCLE_SESSION_CAP[tier]);
}

// ── Ramp curve (session-level, muscle-total) ─────────────────────────────
//
// Table 1 is the WEEK-3 PEAK (MAV). Ramp interpolates DOWN from the peak
// so we never overshoot MAV, regardless of how many slots a day happens
// to have:
//
//   strength: FLAT weeks 1–3. Volume-progression on the muscle lane;
//             load-progression on strength — sets don't climb.
//   muscle:   wk1 = max(2, peak - 2)   (MEV-side)
//             wk2 = max(2, peak - 1)
//             wk3 = peak                (MAV)
//   week 4:   deloadSets(peak) on both lanes.
//
// Floor at 2 sets/slot preserves stimulus — a 1-set exercise is priming,
// not training. When the ramp can't hit the target total without breaking
// the floor, we accept the higher number (rare; only happens on tiny
// session peaks like 3–4).

// Local mirror of planGeneration.deloadSets to keep this module a leaf.
// Formula matches EXACTLY: ceil(sets * 0.6), floor at 1. If planGeneration
// ever tunes deloadSets, mirror that here — the deload composition test
// pins the invariant.
function localDeloadSets(sets: number): number {
  if (!Number.isFinite(sets) || sets <= 0) return 1;
  return Math.max(1, Math.ceil(sets * 0.6));
}

export type BlockWeek = 1 | 2 | 3 | 4;

/** Muscle-total session sets for a given block week. */
export function rampTargetSets(sessionPeak: number, lane: EngineLane, blockWeek: BlockWeek): number {
  if (sessionPeak <= 0) return 0;
  if (blockWeek === 4) return localDeloadSets(sessionPeak);
  if (lane === 'strength') return sessionPeak;
  // muscle lane
  if (blockWeek === 3) return sessionPeak;
  if (blockWeek === 2) return Math.max(2, sessionPeak - 1);
  return Math.max(2, sessionPeak - 2);
}

// ── Slot allocation ──────────────────────────────────────────────────────
//
// Given the muscle's session peak sets and the lane's compound:isolation
// ratio, produce an ordered list of slots. Each slot is one exercise; the
// per-week sets number varies with the ramp curve but the slot IDENTITY is
// fixed within the block.

export interface MuscleSlot {
  /** The muscle group (chest / back / triceps / …). */
  muscle: string;
  /** What kind of exercise the picker should choose for this slot. */
  compoundHint: 'compound' | 'isolation';
  /** True for the first compound slot of a major muscle — the "primary
   *  anchor" for load progression across the block. */
  isPrimarySlot: boolean;
  /** Sets per week: index by blockWeek (1..4). Wk4 is the deload count. */
  setsByWeek: Record<BlockWeek, number>;
}

/** Even-split distribution of `total` across `count` bins, biased so
 *  earlier bins (higher priority — compounds first) get any extras. */
function distributeEven(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const extra = total - base * count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(base + (i < extra ? 1 : 0));
  return out;
}

/** Slot count for a muscle at a given session peak. Aim ~3 sets/exercise.
 *  Session peaks ≤ 3 collapse to a single slot; larger peaks get more. */
function slotCountForPeak(sessionPeak: number): number {
  if (sessionPeak <= 0) return 0;
  if (sessionPeak <= 3) return 1;
  return Math.max(2, Math.floor(sessionPeak / 3));
}

/** Compound slot count for a major muscle at a given lane × slot count.
 *  Floor (rather than round) so the isolation slots have room to absorb
 *  the ramp — a 3-slot muscle-lane muscle wants 1 compound + 2 isolation
 *  so the ramp adds sets on isolations. Small muscles → 0 compound (all
 *  isolation slots), but the picker may still pick a compound anchor if
 *  the catalog fits (chin-up for biceps, close-grip bench for triceps). */
function compoundSlotCount(tier: MuscleTier, lane: EngineLane, slotCount: number): number {
  if (tier === 'small') return 0;
  const desired = Math.floor(slotCount * COMPOUND_RATIO[lane]);
  return Math.max(1, Math.min(desired, slotCount));
}

/** Scale a per-slot sets array DOWN to hit `targetTotal`, subtracting 1
 *  set at a time from the END of the array (lowest priority — isolation
 *  first). Never lets a slot fall below `minPerSlot`; when no slot has
 *  room to shrink, returns whatever floor was reached. */
function scaleDown(sets: number[], targetTotal: number, minPerSlot: number): number[] {
  const out = [...sets];
  let total = out.reduce((a, b) => a + b, 0);
  while (total > targetTotal) {
    let didRemove = false;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] > minPerSlot) {
        out[i]--;
        total--;
        didRemove = true;
        break;
      }
    }
    if (!didRemove) break;
  }
  return out;
}

/** Build slots for one muscle. Compounds get 3 (or 4 for the strength
 *  primary anchor) sets fixed; isolations absorb the ramp delta. */
function allocateSlotsForMuscle(
  muscle: string,
  lane: EngineLane,
  sessionPeak: number,
): MuscleSlot[] {
  const tier = muscleTier(muscle);
  if (tier == null || sessionPeak <= 0) return [];

  const slotCount = slotCountForPeak(sessionPeak);
  const compoundCount = compoundSlotCount(tier, lane, slotCount);
  const isolationCount = slotCount - compoundCount;

  // Assign fixed compound sets (primary=4 on strength, 3 elsewhere).
  const primaryCompoundSets = lane === 'strength' ? 4 : 3;
  const otherCompoundSets = 3;

  const peakSlotSets: number[] = [];
  for (let i = 0; i < compoundCount; i++) {
    peakSlotSets.push(i === 0 ? primaryCompoundSets : otherCompoundSets);
  }
  const compoundSum = peakSlotSets.reduce((a, b) => a + b, 0);
  const isolationBudget = Math.max(0, sessionPeak - compoundSum);
  const isoDist = distributeEven(isolationBudget, isolationCount);
  peakSlotSets.push(...isoDist);

  // When compound sets alone already exceed sessionPeak (rare: small peaks
  // with a mandatory compound), trim compounds down to fit.
  if (compoundSum > sessionPeak && compoundCount > 0) {
    const scaled = scaleDown(peakSlotSets.slice(0, compoundCount), sessionPeak, 2);
    for (let i = 0; i < compoundCount; i++) peakSlotSets[i] = scaled[i];
  }

  // Per-week set counts for each slot. Compute the target muscle total for
  // each blockWeek, then scale the peak distribution down (preserving
  // relative slot priority — trim last slot first).
  const setsWk3 = peakSlotSets;
  const setsWk2 = scaleDown(peakSlotSets, rampTargetSets(sessionPeak, lane, 2), 2);
  const setsWk1 = scaleDown(peakSlotSets, rampTargetSets(sessionPeak, lane, 1), 2);
  const setsWk4 = scaleDown(peakSlotSets, rampTargetSets(sessionPeak, lane, 4), 2);

  const slots: MuscleSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    const isCompound = i < compoundCount;
    slots.push({
      muscle,
      compoundHint: isCompound ? 'compound' : 'isolation',
      isPrimarySlot: isCompound && i === 0,
      setsByWeek: {
        1: setsWk1[i],
        2: setsWk2[i],
        3: setsWk3[i],
        4: setsWk4[i],
      },
    });
  }
  return slots;
}

// ── Whole-session trim ───────────────────────────────────────────────────
// After all muscles' slots are allocated, the day's total may exceed the
// WHOLE_SESSION_CAP or MAX_MOVEMENTS. Trim runs in TWO PHASES with a
// three-tier priority for what to touch:
//
//   Priority (least to most protected):
//     1. Non-primary isolation slots  ← trimmed / dropped first
//     2. Non-primary compound slots   ← trimmed only if step 1 exhausted
//     3. Primary compound anchors     ← last-resort set trim, never dropped
//
//   Phase A — movement count. Drop slots from the tail until slot count
//     ≤ MAX_MOVEMENTS[lane]. Only drops slots in priority tier 1 or 2 and
//     NEVER a muscle's last remaining slot (so no muscle disappears).
//   Phase B — set count. Cut sets from lowest-priority slots first, floor
//     at 2 sets/slot to preserve stimulus. Ramp values (wk1/wk2/wk4) are
//     re-synced so a trimmed peak still parses coherently downstream.
//
// The trim FIRES on realistic input (Case D strength push has 8 slots / 28
// sets against caps 6 / 20). It is not a defensive fallback — it's the
// mechanism that turns "sum of per-muscle peaks" into a session that
// actually fits at strength pace.

function totalPeakSets(muscles: { slots: MuscleSlot[] }[]): number {
  let s = 0;
  for (const m of muscles) for (const slot of m.slots) s += slot.setsByWeek[3];
  return s;
}

/** Sync a slot's ramp values (wk1, wk2, wk4) to a newly-trimmed wk3 peak.
 *  wk1/wk2 can't exceed the peak; wk4 recomputes off the peak's deload. */
function resyncRampAfterTrim(slot: MuscleSlot): void {
  const peak = slot.setsByWeek[3];
  if (slot.setsByWeek[2] > peak) slot.setsByWeek[2] = peak;
  if (slot.setsByWeek[1] > peak) slot.setsByWeek[1] = peak;
  slot.setsByWeek[4] = localDeloadSets(peak);
}

function trimToSessionCap(
  muscles: { slots: MuscleSlot[] }[],
  lane: EngineLane,
): void {
  const cap = WHOLE_SESSION_CAP[lane];
  const maxMoves = MAX_MOVEMENTS[lane];
  const countSlots = () => muscles.reduce((a, m) => a + m.slots.length, 0);

  // ── Phase A · movement-count trim ──────────────────────────────────
  // Drop slots from the LAST muscle backward. Never drop a muscle's last
  // remaining slot, a primary anchor, or (round 1) a compound slot.
  const dropOne = (allowCompound: boolean): boolean => {
    for (let m = muscles.length - 1; m >= 0; m--) {
      const arr = muscles[m].slots;
      if (arr.length <= 1) continue; // preserve at least one slot per muscle
      for (let s = arr.length - 1; s >= 0; s--) {
        const slot = arr[s];
        if (slot.isPrimarySlot) continue;
        if (!allowCompound && slot.compoundHint === 'compound') continue;
        arr.splice(s, 1);
        return true;
      }
    }
    return false;
  };
  while (countSlots() > maxMoves) {
    if (dropOne(false)) continue;         // try non-primary iso first
    if (dropOne(true)) continue;          // then non-primary compound
    break;                                 // nothing left to drop safely
  }

  // ── Phase B · set-count trim ───────────────────────────────────────
  // Cut one set at a time from the lowest-priority slot with room (>2).
  // Three rounds by priority tier: non-primary iso → non-primary compound
  // → primary anchor (last resort — floor 2 stimulus).
  const trimOne = (tier: 'iso' | 'nonprim' | 'any'): boolean => {
    for (let m = muscles.length - 1; m >= 0; m--) {
      const arr = muscles[m].slots;
      for (let s = arr.length - 1; s >= 0; s--) {
        const slot = arr[s];
        if (slot.setsByWeek[3] <= 2) continue;
        if (tier === 'iso') {
          if (slot.isPrimarySlot) continue;
          if (slot.compoundHint === 'compound') continue;
        } else if (tier === 'nonprim') {
          if (slot.isPrimarySlot) continue;
        }
        slot.setsByWeek[3]--;
        resyncRampAfterTrim(slot);
        return true;
      }
    }
    return false;
  };
  while (totalPeakSets(muscles) > cap) {
    if (trimOne('iso')) continue;
    if (trimOne('nonprim')) continue;
    if (trimOne('any')) continue;
    break;
  }
}

// ── Top-level orchestrator ───────────────────────────────────────────────
//
// buildDayStructure( goal, dayType, location, level, split, trainingDays )
//   →  DayStructure { muscles: [{ muscle, slots: MuscleSlot[] }, ...] }
//
// Consumers (generatePlan): flatten muscles[].slots to drive the picker;
// use each slot's compoundHint to bias selection, isPrimarySlot to hold
// the anchor stable across blocks, and setsByWeek[blockWeek] to stamp
// per-exercise sets.

export interface DayStructure {
  /** Ordered priority list — first entry gets the session's opening slot. */
  muscles: { muscle: string; slots: MuscleSlot[] }[];
}

export interface BuildDayStructureArgs {
  goal: EngineLane;
  dayType: string;
  location: Location;
  level: FitnessLevel;
  split: SplitId;
  trainingDays: number;
}

/** True if the engine can build structure for this (split, dayType) pair. */
export function isEngineSupportedDayType(split: SplitId, dayType: string): boolean {
  return DAY_TYPE_MUSCLES[split]?.[dayType] != null;
}

/** Build the ordered slot structure for one day. Returns null when the
 *  engine has no muscle list for the (split, dayType) — caller should
 *  fall back to the SPLIT_RULES path in that case. */
export function buildDayStructure(args: BuildDayStructureArgs): DayStructure | null {
  const { goal, dayType, location, level, split, trainingDays } = args;
  void location; // location is used by generatePlan's picker; here it's
                 // reserved for future location-aware muscle lists.
  const muscles = DAY_TYPE_MUSCLES[split]?.[dayType];
  if (!muscles) return null;

  const out: { muscle: string; slots: MuscleSlot[] }[] = [];
  for (const muscle of muscles) {
    const freq = computeFrequency(split, trainingDays, muscle);
    if (freq <= 0) continue;
    const sessionPeak = sessionPeakSets(muscle, goal, level, freq);
    if (sessionPeak <= 0) continue;
    const slots = allocateSlotsForMuscle(muscle, goal, sessionPeak);
    if (slots.length > 0) out.push({ muscle, slots });
  }

  trimToSessionCap(out, goal);
  return { muscles: out };
}

// ── Exposed constants (for tests + coach copy) ──────────────────────────

export const PLAN_RULES_TABLES = {
  WEEKLY_PEAK_SETS,
  PER_MUSCLE_SESSION_CAP,
  WHOLE_SESSION_CAP,
  MAX_MOVEMENTS,
  COMPOUND_RATIO,
  DAY_TYPE_MUSCLES,
  MAJOR_MUSCLES,
  SMALL_MUSCLES,
} as const;
