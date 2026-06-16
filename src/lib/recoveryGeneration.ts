// Deterministic recovery / prehab session generator.
//
// Mirrors the style of src/lib/planGeneration.ts: pure (no Supabase, no
// clock, no Math.random), same FNV-1a + mulberry32 seeded PRNG, takes a
// small args object and returns a session object.
//
// Output is tagged isRecovery=true so the consumer can persist it with
// workout_sessions.is_recovery=true and stay invisible to PR detection /
// load progression / RIR autoregulation / the mesocycle. See
// src/lib/recovery.ts for the read-side exclusion boundary.
//
// Composition rules:
//   - 2–3 mobility items (full-body / area-balanced from the catalog).
//   - 1–2 prehab items biased toward neglected fast-recovering areas:
//     neck, rotator cuff & scapular, forearms / grip, calves / ankles.
//     Already-fatigued areas (from recentlyTrainedAreas) are skipped.
//   - Light core ONLY when the strength program isn't already core-heavy
//     via compounds. Skipped for full_body and upper_lower (every session
//     has squat/DL); included for ppl and bro_split.
//   - High-frequency users (≥ 5 days/week) get a SHORTER session and the
//     "genuine rest is also fine today" note — the goal is to make rest
//     viable, not to add load.
//
// Copy rules (inherited from the catalog + enforced by the note copy):
//   - "Move better / feel less stiff." NEVER "injury prevention",
//     "rehab", "fix your X", or "see a physio".
//   - Doses are explicitly light — durations or easy sets×reps. Never
//     working-set numbers.

import {
  RECOVERY_EXERCISES,
  type RecoveryArea,
  type RecoveryCategory,
  type RecoveryEquipment,
  type RecoveryExercise,
  type RecoveryMenuCategory,
} from '../constants/recoveryExercises';
import type { Location, SplitId } from './planGeneration';

export type { RecoveryMenuCategory } from '../constants/recoveryExercises';

// ── Seeded PRNG ────────────────────────────────────────────────────────
// Same FNV-1a + mulberry32 pair used in planGeneration. Copied (not
// imported) to keep this module standalone — the recovery generator must
// not pick up any future change to the plan-generation PRNG quietly.

function hashStr(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

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

function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Output types ──────────────────────────────────────────────────────

/** Display-friendly recovery item. Mirrors RecoveryExercise but flattens
 *  the dose into two nullable fields so the UI doesn't have to dig into
 *  a nested object to render "2 × 15" vs. "60s per side". */
export interface RecoverySessionExercise {
  name: string;
  category: RecoveryCategory;
  area: RecoveryArea;
  equipment: RecoveryEquipment;
  /** Sets × reps string, e.g. "2 × 15 controlled". Null when the item is
   *  duration-based. */
  setsReps: string | null;
  /** Duration string, e.g. "60s per side". Null when the item is
   *  sets×reps-based. */
  duration: string | null;
  cue: string;
  /** Optional thumbnail URL (mirrors RecoveryExercise.imageUrl). Undefined
   *  when the catalog item has no good free-exercise-db match — the card
   *  falls back to a per-category illustration block. */
  imageUrl?: string;
}

export interface RecoverySession {
  /** Recovery tag. The session writer stores this on
   *  workout_sessions.is_recovery and on every exercise_logs row it
   *  emits (see src/lib/recovery.ts for the read-side exclusion). Every
   *  rest-day session is recovery now — these extras never feed PR
   *  detection, load prescription, or RIR autoregulation. */
  isRecovery: boolean;
  /** Display + storage label. Bare category name (e.g. "Core", "Mobility")
   *  — no "Recovery — " prefix. The is_recovery column is the source of
   *  truth for the exclusion boundary; the legacy workout_type prefix
   *  fallback in src/lib/recovery.ts still works for older rows. */
  workoutType: string;
  location: Location;
  /** Composed items in display order: mobility → prehab → core. */
  exercises: RecoverySessionExercise[];
  /** One-line coach note shown above the items. Encodes the "genuine
   *  rest is also fine today" message for high-frequency users; for
   *  others a quality-over-volume reminder. Plain text, no claims. */
  note: string;
}

// ── Composition policy ───────────────────────────────────────────────

/** The "neglected fast-recovering" prehab targets. Tasks the recovery
 *  session is explicitly for. Glutes / hips / hamstrings are catalog
 *  items but live in the mobility bucket — they aren't picked here. */
const PREHAB_TARGETS: ReadonlySet<RecoveryArea> = new Set<RecoveryArea>([
  'neck', 'rotator_cuff', 'scapular', 'forearms', 'grip', 'calves', 'ankles',
]);

/** Map recently-trained body-region tags to prehab areas the recovery
 *  session should AVOID — they're already taxed. Keys are lowercased
 *  catalog/split tags ('push', 'pull', 'legs', 'chest', 'back', etc.). */
const FATIGUE_MAP: Record<string, readonly RecoveryArea[]> = {
  push:      ['rotator_cuff', 'scapular'],
  chest:     ['rotator_cuff', 'scapular'],
  shoulders: ['rotator_cuff', 'scapular'],
  triceps:   ['rotator_cuff'],
  pull:      ['scapular'],
  back:      ['scapular'],
  biceps:    ['scapular'],
  arms:      ['forearms', 'rotator_cuff'],
  legs:      ['calves', 'ankles'],
  upper:     ['rotator_cuff', 'scapular'],
  lower:     ['calves', 'ankles'],
  full_body: ['rotator_cuff', 'scapular', 'calves'],
};

function fatiguedAreas(recentlyTrained: readonly string[]): Set<RecoveryArea> {
  const out = new Set<RecoveryArea>();
  for (const tag of recentlyTrained) {
    const t = (tag ?? '').toLowerCase();
    const areas = FATIGUE_MAP[t];
    if (!areas) continue;
    for (const a of areas) out.add(a);
  }
  return out;
}

/**
 * Skip light core when the strength program already taxes it heavily
 * through compounds (squat/deadlift/OHP every week or more). Also skip
 * for high-frequency users — the session is meant to be shorter.
 */
function shouldIncludeCore(split: SplitId, isHighFreq: boolean): boolean {
  if (isHighFreq) return false;
  if (split === 'full_body') return false;
  if (split === 'upper_lower') return false;
  return true; // ppl, bro_split
}

// ── Public: generator ────────────────────────────────────────────────

export interface GenerateRecoverySessionArgs {
  /** Body-region tags the user trained recently — used to skip prehab
   *  areas that are already taxed. Empty allowed. Case-insensitive. */
  recentlyTrainedAreas?: readonly string[];
  split: SplitId;
  /** 1–7. ≥ 5 triggers the high-frequency bias (shorter session + the
   *  "rest is also fine" note). */
  trainingDays: number;
  location: Location;
  /** Optional seed material for deterministic variation across days.
   *  Production callers should pass today's YYYY-MM-DD so two recovery
   *  sessions on the same day are identical and consecutive days vary.
   *  Defaults to '' (constant). */
  seedKey?: string;
  /** Menu category the user picked. When provided, the generator returns
   *  a single-category session (e.g. just core, or just cardio). When
   *  omitted, falls back to the legacy multi-category composition
   *  (mobility + prehab + core). The rest-day picker in app/recovery.tsx
   *  always provides one. */
  category?: RecoveryMenuCategory;
}

// ── Menu mapping ──────────────────────────────────────────────────────
// Each user-facing menu category corresponds to a filter over the
// (category, area) space of the catalog. Kept here so the catalog stays
// semantic and the menu can present friendlier groupings.

function matchesMenuCategory(ex: RecoveryExercise, menu: RecoveryMenuCategory): boolean {
  switch (menu) {
    case 'core':
      return ex.category === 'core';
    case 'forearms_grip':
      return ex.category === 'prehab' && (ex.area === 'forearms' || ex.area === 'grip');
    case 'calves':
      return ex.category === 'prehab' && (ex.area === 'calves' || ex.area === 'ankles');
    case 'cardio':
      return ex.category === 'cardio';
    case 'mobility':
      return ex.category === 'mobility';
  }
}

/** A rest-day session is intentionally short — three good moves, never a
 *  full circuit. Caps every menu pick regardless of the per-category count. */
export const MAX_RECOVERY_ITEMS = 3;

/** How many items to include for a given user-explicit menu pick. The
 *  high-frequency bias still shortens; the core-heavy split rule
 *  LIGHTENS core picks rather than skipping (the user explicitly opted
 *  in — we respect that, just dial down). Cardio is always 1 item — it's
 *  a single steady-state activity, not a circuit. */
function menuItemCount(
  menu: RecoveryMenuCategory,
  split: SplitId,
  isHighFreq: boolean,
): number {
  switch (menu) {
    case 'cardio':
      return 1;
    case 'calves':
      return 2;
    case 'core': {
      // Core gating: lighter dose (1 item) when the split already taxes
      // core via compounds (full_body / upper_lower) OR when the user is
      // high-frequency. Otherwise full dose (2–3 items).
      const coreHeavy = split === 'full_body' || split === 'upper_lower';
      if (coreHeavy || isHighFreq) return 1;
      return 3;
    }
    case 'forearms_grip':
      return isHighFreq ? 2 : 3;
    case 'mobility':
      return isHighFreq ? 3 : 4;
  }
}

/** Per-menu note copy. Light dose framing for everything; cardio gets
 *  its explicit conversational-pace reminder so the user doesn't slip
 *  into intervals. */
function menuNote(menu: RecoveryMenuCategory, isHighFreq: boolean): string {
  if (menu === 'cardio') {
    return isHighFreq
      ? 'Easy conversational pace. Genuine rest is also fine today.'
      : 'Easy conversational pace — circulation, not conditioning.';
  }
  return isHighFreq
    ? "Light dose — won't touch tomorrow's session. Genuine rest is also fine today."
    : "Light dose — won't touch tomorrow's session.";
}

/**
 * Pure: rest-day menu picks all count as recovery now. Kept as a function
 * so external callers can phrase the rule explicitly without coupling to
 * the data model. Every category writes is_recovery=true on the session
 * and on every exercise_logs row — these extras never feed PR detection,
 * load prescription, RIR autoregulation, or the mesocycle.
 */
export function categoryIsRecovery(_menu: RecoveryMenuCategory): boolean {
  return true;
}

/** Friendly title that becomes workout_type on the saved session row.
 *  Bare category names — no "Recovery — " prefix. The is_recovery column
 *  is the source of truth for the exclusion boundary; the workout_type
 *  prefix fallback in src/lib/recovery.ts remains for legacy rows but is
 *  not relied on by new writes. */
function menuTitle(menu: RecoveryMenuCategory): string {
  switch (menu) {
    case 'core':          return 'Core';
    case 'forearms_grip': return 'Forearms & Grip';
    case 'calves':        return 'Calves';
    case 'cardio':        return 'Cardio';
    case 'mobility':      return 'Mobility';
  }
}

/**
 * Build a recovery / prehab session from the args. Deterministic: same
 * inputs ⇒ exactly the same exercises in the same order. Pure: no I/O,
 * no clock, no Math.random.
 *
 * The returned object is meant to be stored as a workout_sessions row
 * with `is_recovery = true` (see src/lib/recovery.ts). Every exercise_logs
 * row written for this session must also carry `is_recovery = true` so
 * the read-side exclusion boundary holds.
 */
export function generateRecoverySession(args: GenerateRecoverySessionArgs): RecoverySession {
  const { split, trainingDays, location } = args;
  const recentlyTrainedAreas = args.recentlyTrainedAreas ?? [];
  const seedKey = args.seedKey ?? '';
  const isHighFreq = trainingDays >= 5;

  // 1. Filter catalog by location once. Items tagged 'both' are always
  //    valid; gym-only and home-only items only show on matching context.
  const inLoc = RECOVERY_EXERCISES.filter(
    ex => ex.location === 'both' || ex.location === location,
  );

  // Single-category mode — the rest-day picker's menu path.
  if (args.category) {
    return buildSingleCategorySession({
      category: args.category,
      inLoc,
      split,
      isHighFreq,
      location,
      seedKey,
    });
  }

  // 2. Slot allocation — total is capped at MAX_RECOVERY_ITEMS (3) so the
  //    session reads as a short, deliberate set rather than a circuit.
  //    Variety beats depth: take 1 prehab + (0–1) core + fill remaining
  //    slots with mobility. shouldIncludeCore decides core based on split
  //    and frequency.
  const wantsCore = shouldIncludeCore(split, isHighFreq);
  const prehabCount = 1;
  const coreCount = wantsCore ? 1 : 0;
  const mobilityCount = Math.max(0, MAX_RECOVERY_ITEMS - prehabCount - coreCount);

  // 3. Build the seeded PRNG. Every input is mixed in so identical args
  //    produce identical sessions; the optional seedKey lets the caller
  //    rotate selection day-to-day. Areas are sorted+lowercased for a
  //    stable seed regardless of input order.
  const sortedAreas = [...recentlyTrainedAreas].map(s => s.toLowerCase()).sort().join(',');
  const seedStr = `rec|s:${split}|d:${trainingDays}|l:${location}|a:${sortedAreas}|k:${seedKey}`;
  const rand = mulberry32(hashStr(seedStr));

  // 4. Pick mobility. Deterministic shuffle + take.
  const mobilityPool = inLoc.filter(ex => ex.category === 'mobility');
  const mobShuffle = [...mobilityPool];
  shuffleInPlace(mobShuffle, rand);
  const pickedMobility = mobShuffle.slice(0, mobilityCount);

  // 5. Pick prehab. Bias toward neglected fast-recovering areas; remove
  //    areas the user just trained. Diversify by area before doubling up.
  const fatigued = fatiguedAreas(recentlyTrainedAreas);
  const prehabAll = inLoc.filter(
    ex => ex.category === 'prehab' && PREHAB_TARGETS.has(ex.area),
  );
  const prehabNeglected = prehabAll.filter(ex => !fatigued.has(ex.area));
  // Defensive: if every target area is fatigued (rare), fall back to the
  // unfiltered prehab pool so we never return an empty bucket.
  const prehabPool = prehabNeglected.length > 0 ? prehabNeglected : prehabAll;
  const prehabShuffle = [...prehabPool];
  shuffleInPlace(prehabShuffle, rand);

  const pickedPrehab: RecoveryExercise[] = [];
  const seenPrehabAreas = new Set<RecoveryArea>();
  // Pass 1: one per distinct area until we hit the count.
  for (const ex of prehabShuffle) {
    if (pickedPrehab.length >= prehabCount) break;
    if (seenPrehabAreas.has(ex.area)) continue;
    pickedPrehab.push(ex);
    seenPrehabAreas.add(ex.area);
  }
  // Pass 2: if area diversity ran out (small pool), fill remaining slots.
  for (const ex of prehabShuffle) {
    if (pickedPrehab.length >= prehabCount) break;
    if (pickedPrehab.includes(ex)) continue;
    pickedPrehab.push(ex);
  }

  // 6. Pick core (only when applicable).
  let pickedCore: RecoveryExercise[] = [];
  if (coreCount > 0) {
    const corePool = inLoc.filter(ex => ex.category === 'core');
    const coreShuffle = [...corePool];
    shuffleInPlace(coreShuffle, rand);
    pickedCore = coreShuffle.slice(0, coreCount);
  }

  // 7. Compose output. Map RecoveryExercise → display shape; the cue and
  //    dose are passed through verbatim from the catalog (the generator
  //    never invents copy).
  const toOut = (ex: RecoveryExercise): RecoverySessionExercise => ({
    name: ex.name,
    category: ex.category,
    area: ex.area,
    equipment: ex.equipment,
    setsReps: ex.dose.setsReps ?? null,
    duration: ex.dose.duration ?? null,
    cue: ex.cue,
    imageUrl: ex.imageUrl,
  });

  const exercises = [
    ...pickedMobility.map(toOut),
    ...pickedPrehab.map(toOut),
    ...pickedCore.map(toOut),
  ].slice(0, MAX_RECOVERY_ITEMS);

  // High-frequency users get the rest-is-fine note explicitly. For others
  // we still emit a light-dose reminder so the session reads as a coach
  // choice, not an instruction set.
  const note = isHighFreq
    ? 'Genuine rest is also fine today — this dose is light on purpose.'
    : 'Light dose — move clean, not heavy.';

  return {
    isRecovery: true,
    workoutType: 'Mobility & Prehab',
    location,
    exercises,
    note,
  };
}

// ── Single-category builder (menu-driven) ─────────────────────────────
// Used when the user has explicitly picked a category from the rest-day
// menu. Pure: same args ⇒ same output, deterministic seeded shuffle.
// The output is shape-compatible with the multi-category path so the
// rest of the app doesn't need to branch on which mode was used.

interface BuildSingleCategoryArgs {
  category: RecoveryMenuCategory;
  inLoc: readonly RecoveryExercise[];
  split: SplitId;
  isHighFreq: boolean;
  location: Location;
  seedKey: string;
}

function buildSingleCategorySession(args: BuildSingleCategoryArgs): RecoverySession {
  const { category, inLoc, split, isHighFreq, location, seedKey } = args;

  // Pool is the (location-filtered) catalog intersected with the menu's
  // (category, area) filter.
  const pool = inLoc.filter(ex => matchesMenuCategory(ex, category));

  // Seed mixes the menu category so two different menu picks on the
  // same day yield different sessions, while a single pick is stable
  // across repeated taps.
  const seedStr = `rec-menu|c:${category}|s:${split}|l:${location}|k:${seedKey}`;
  const rand = mulberry32(hashStr(seedStr));

  // Always give a full short session: MAX_RECOVERY_ITEMS (3) per pick,
  // clamped only by what the pool actually holds. Cardio is the one
  // exception — it's a single steady-state activity, not a circuit.
  const wantCount = category === 'cardio' ? 1 : MAX_RECOVERY_ITEMS;
  // Defensive: never request more than the pool has. Empty pools shouldn't
  // happen with the current catalog + a real split/location pair, but a
  // future trim of the catalog mustn't crash the screen.
  const takeCount = Math.min(wantCount, pool.length);

  // Seeded shuffle first (day-to-day variety), THEN stable-sort by quality
  // descending so staples (plank, hanging knee raise) win the slots over
  // filler (dead bug, bird dog) while equal-quality items still rotate.
  // Hermes' Array.sort is stable, so the shuffle order is preserved within
  // each quality tier.
  const shuffle = [...pool];
  shuffleInPlace(shuffle, rand);
  shuffle.sort((a, b) => (b.quality ?? 2) - (a.quality ?? 2));
  const picked = shuffle.slice(0, takeCount);

  const toOut = (ex: RecoveryExercise): RecoverySessionExercise => ({
    name: ex.name,
    category: ex.category,
    area: ex.area,
    equipment: ex.equipment,
    setsReps: ex.dose.setsReps ?? null,
    duration: ex.dose.duration ?? null,
    cue: ex.cue,
    imageUrl: ex.imageUrl,
  });

  return {
    isRecovery: categoryIsRecovery(category),
    workoutType: menuTitle(category),
    location,
    exercises: picked.map(toOut),
    note: menuNote(category, isHighFreq),
  };
}
