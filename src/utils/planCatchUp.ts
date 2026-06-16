// Catch-up plan packer for the GapModal "continue where I left off" path.
//
// The product rule: when the user returns from an absence, stack their
// missed-plus-upcoming workouts on CONSECUTIVE calendar days starting
// today — no rest days between — until the missed backlog is consumed,
// then resume normal weekday cadence.
//
// Order of dayTypes is the generator's canonical sequence (PPL cycle,
// upper/lower alternation, bro-split weekly template). This module is
// the only path that produces resume rows; we never reorder stored
// PlanDays. That contract is what kept the previous rigid-shift code
// out of sync when a missed legs day surfaced as `legs → chest` instead
// of `legs → push`.
//
// Pure: no Supabase, no AsyncStorage, no clock. The caller pre-fetches
// inputs (profile, completed-session counts, plan history, block math)
// and passes everything in.

import {
  generatePlan,
  type FitnessLevel,
  type Location,
  type PlanDay,
  type SplitId,
} from '../lib/planGeneration';

export interface BuildCatchUpRowsArgs {
  /** Local YYYY-MM-DD for "today" — anchor day 0 of the catch-up pack. */
  todayIso: string;
  /** Number of past unfinished planned training days. The first N
   *  sessions in the result land on today, today+1, …, today+N-1. */
  backlogN: number;
  /** Generator phase. For PPL, upper_lower, full_body this controls the
   *  rotation step (`dayIndexOffset`). For bro_split it is consumed by
   *  generatePlan but doesn't move the fixed weekly template — that
   *  template stays anchored on `inWeekIdx` per generator contract. */
  mesocyclePosition: number;
  trainingDays: number;
  fitnessLevel: FitnessLevel;
  location: Location;
  /** The user's chosen split (profiles.preferred_split). Passed straight to
   *  generatePlan so a resume/catch-up keeps the user's split — not a
   *  days-derived one. Omitted → generatePlan falls back to splitForDays. */
  split?: SplitId;
  /** Last 4 weeks of plan history for the generator's variety scoring.
   *  Passed straight through to generatePlan. */
  planHistory?: { exercises: string[] }[];
  /** Block in the 4-week mesocycle (0-indexed). Same value passed to
   *  generatePlan for both catch-up and future segments — the block
   *  itself doesn't roll during a catch-up. */
  blockIndex: number;
  /** In-block week (1..4) at today. The catch-up segment uses this
   *  verbatim; the future segment increments by floor(N / 7) so the
   *  deload week still lands on the correct calendar week. */
  blockWeek: number;
  /** Optional override for the user's normal cadence offsets. Defaults
   *  to the same spread `pickDefaultDayOffsets` produces (Mon/Wed/Fri
   *  for 3 days, etc.). */
  selectedDayOffsets?: number[];
  /** Total horizon weeks to build (default 4 — matches planSync). */
  horizonWeeks?: number;
  /** Stable 7-day grid origin. When provided, generated rows align to
   *  `gridAnchor + 7k` (k = 0, 1, …) so two catch-up runs on different
   *  weekdays produce IDENTICAL row boundaries. Without it, rows
   *  anchor at todayIso — two runs three days apart would then emit
   *  partially-overlapping rows like [Wed..Tue] and [Sat..Fri], the
   *  exact bug that lets the same calendar date map to different
   *  workout types. Callers in home.tsx pass the user's plan anchor
   *  (earliest weekly_plans row); legacy callers / tests can omit it
   *  and get today-anchored rows. */
  gridAnchor?: string;
}

export interface CatchUpRow {
  /** Row key. Each row covers [weekStart, weekStart+6]. */
  weekStart: string;
  /** PlanDays whose date falls within this row's 7-day window. Rest
   *  days are implicit (not materialized). */
  planDays: PlanDay[];
}

export interface CatchUpRowsResult {
  rows: CatchUpRow[];
}

// ── Local helpers (pure) ──────────────────────────────────────────────

/** YYYY-MM-DD for (anchorIso + days), local time. */
function addDays(anchorIso: string, days: number): string {
  const p = anchorIso.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Integer day delta between two YYYY-MM-DD strings (b − a), local time. */
function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const da = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
  const db = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
  return Math.round((db - da) / 86400000);
}

const DAY_NAMES_LONG = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

function weekdayName(iso: string): string {
  const p = iso.split('-').map(Number);
  return DAY_NAMES_LONG[new Date(p[0], p[1] - 1, p[2]).getDay()];
}

/** Mirror of planGeneration's private pickDefaultDayOffsets. Kept in
 *  sync deliberately — the spec doesn't allow changing the canonical
 *  cadence pattern. */
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

// ── Public ────────────────────────────────────────────────────────────

/**
 * Build a catch-up plan: N consecutive training days starting today, then
 * normal cadence. Returns rows bucketed into 7-day windows anchored at
 * today, today+7, today+14, …
 *
 * Idempotent: when backlogN === 0 the catch-up segment is empty and the
 * result is just a fresh normal-cadence horizon anchored at today —
 * exactly what `ensureCurrentWeekPlan` would produce in the no-miss case.
 * The caller's gate (skip when backlogN === 0) makes resume a strict
 * no-op in that scenario.
 *
 * Limitation: for bro_split, the fixed weekly template restarts at chest
 * — generatePlan's 'fixed' rotation is keyed on inWeekIdx, not on
 * dayIndexOffset. PPL / upper_lower / full_body resume rotation at the
 * user's true next type.
 */
export function buildCatchUpRows(args: BuildCatchUpRowsArgs): CatchUpRowsResult {
  const horizonWeeks = Math.max(1, args.horizonWeeks ?? 4);
  const selectedDayOffsets = args.selectedDayOffsets ?? pickDefaultDayOffsets(args.trainingDays);
  const backlogN = Math.max(0, Math.floor(args.backlogN));

  const allSessions: PlanDay[] = [];

  // ── 1. Catch-up segment: N back-to-back days starting today ────────
  //
  // selectedDayOffsets=[0,1,2,3,4,5,6] tells generatePlan to materialize a
  // training session every day of the 7-day window. weeksAhead is set
  // large enough to cover N; we slice the first N out and re-stamp their
  // dates as today, today+1, …. For PPL/upper_lower/full_body the
  // dayIndexOffset positions the rotation at the user's next due type;
  // for bro_split the fixed weekly template restarts at chest (see
  // limitation note above).
  let nextDayIndexOffset = args.mesocyclePosition + backlogN;
  let nextAnchor = addDays(args.todayIso, backlogN);
  const catchUpCalendarWeeks = Math.floor(backlogN / 7);
  let nextBlockWeek =
    ((args.blockWeek - 1 + catchUpCalendarWeeks) % 4) + 1;

  if (backlogN > 0) {
    const consecutiveOffsets = [0, 1, 2, 3, 4, 5, 6];
    const catchUpWeeks = Math.max(1, Math.ceil(backlogN / 7));
    const catchUp = generatePlan({
      fitnessLevel: args.fitnessLevel,
      trainingDays: args.trainingDays,
      location: args.location,
      split: args.split,
      planHistory: args.planHistory,
      selectedDayOffsets: consecutiveOffsets,
      weeksAhead: catchUpWeeks,
      startDate: args.todayIso,
      dayIndexOffset: args.mesocyclePosition,
      blockIndex: args.blockIndex,
      blockWeek: args.blockWeek,
    });
    const catchUpSlice = catchUp.slice(0, backlogN);
    // Re-stamp dates as a defensive measure — generatePlan should
    // already have produced consecutive dates from `startDate`.
    catchUpSlice.forEach((day, i) => {
      const newDate = addDays(args.todayIso, i);
      day.date = newDate;
      day.day = weekdayName(newDate);
    });
    allSessions.push(...catchUpSlice);
  }

  // ── 2. Future segment: normal cadence from after the catch-up ──────
  //
  // Anchor at (today + N). Cadence offsets are the user's normal pattern.
  // dayIndexOffset advances by N so the rotation step continues. blockWeek
  // advances by however many CALENDAR weeks the catch-up consumed.
  const future = generatePlan({
    fitnessLevel: args.fitnessLevel,
    trainingDays: args.trainingDays,
    location: args.location,
    split: args.split,
    planHistory: args.planHistory,
    selectedDayOffsets,
    weeksAhead: horizonWeeks,
    startDate: nextAnchor,
    dayIndexOffset: nextDayIndexOffset,
    blockIndex: args.blockIndex,
    blockWeek: nextBlockWeek,
  });
  allSessions.push(...future);

  // ── 3. Bucket sessions into 7-day rows on a STABLE grid ──────────────
  //
  // Grid origin = gridAnchor (when provided) or todayIso. The first row's
  // weekStart is the latest grid line ≤ today, so today falls inside its
  // window. Two runs on different weekdays anchored to the same gridAnchor
  // produce IDENTICAL row weekStarts — the property that prevents
  // partially-overlapping rows from leaking the same calendar date into
  // two different rows.
  //
  // Sessions stay in the row whose [weekStart, weekStart+6] window
  // contains their .date. Sessions beyond the horizon are dropped (the
  // caller's ensureCurrentWeekPlan top-up will extend the horizon as
  // the user moves forward in time).
  const gridAnchor = args.gridAnchor ?? args.todayIso;
  const daysFromAnchor = daysBetween(gridAnchor, args.todayIso);
  // floor(divide) toward negative infinity so a today STRICTLY before the
  // anchor (defensive — shouldn't happen) still resolves to a sensible
  // grid line ≤ today.
  const currentWeekIndex = Math.floor(daysFromAnchor / 7);
  const firstRowStart = addDays(gridAnchor, currentWeekIndex * 7);

  const rows: CatchUpRow[] = [];
  for (let w = 0; w < horizonWeeks; w++) {
    const weekStart = addDays(firstRowStart, w * 7);
    const weekEnd = addDays(firstRowStart, w * 7 + 6);
    const planDays = allSessions.filter(
      s => !!s.date && s.date >= weekStart && s.date <= weekEnd,
    );
    rows.push({ weekStart, planDays });
  }

  return { rows };
}

// ── Current-week self-heal ────────────────────────────────────────────
//
// The stored weekly_plans row for the active week is a CACHE of what the
// generator would produce at the user's true position — not a source of
// truth. True position is fully determined by observables:
//
//   dayIndexOffset = count of completed non-recovery sessions whose
//                    planned_date is STRICTLY BEFORE the week's start
//   blockIndex / blockWeek = the same anchor math planSync already uses
//
// "Before the week's start" (not all-time) keeps the derivation stable
// across the week: completing today's session doesn't change the input,
// so re-running cannot drift (idempotency). Deriving from completions —
// not from the stored row — is what makes the heal converge from ANY
// stored state: a collapsed row, a wrong-typed row, an overlapping-row
// artifact, all get replaced by the same canonical week, with no manual
// row deletion. A miss therefore stays at its canonical position until
// it is completed or explicitly resolved (GapModal resume/skip).

export interface CanonicalWeekArgs {
  /** The active row's week_start (grid-aligned, covers [ws, ws+6]). */
  weekStartIso: string;
  /** Completed non-recovery sessions with planned_date < weekStartIso. */
  completedBeforeWeek: number;
  trainingDays: number;
  fitnessLevel: FitnessLevel;
  location: Location;
  /** The user's chosen split. MUST match what generated the stored row, or the
   *  (date, workoutType) comparison in the self-heal would treat a correct row
   *  as deviating and rewrite it every open. Omitted → splitForDays default. */
  split?: SplitId;
  planHistory?: { exercises: string[] }[];
  blockIndex: number;
  blockWeek: number;
  selectedDayOffsets?: number[];
}

/** The canonical week: generatePlan at the user's true rotation position,
 *  anchored on the active row's own week_start with normal cadence. */
export function deriveCanonicalWeek(args: CanonicalWeekArgs): PlanDay[] {
  return generatePlan({
    fitnessLevel: args.fitnessLevel,
    trainingDays: args.trainingDays,
    location: args.location,
    split: args.split,
    planHistory: args.planHistory,
    selectedDayOffsets: args.selectedDayOffsets ?? pickDefaultDayOffsets(args.trainingDays),
    weeksAhead: 1,
    startDate: args.weekStartIso,
    dayIndexOffset: args.completedBeforeWeek,
    blockIndex: args.blockIndex,
    blockWeek: args.blockWeek,
  });
}

/**
 * Structural equality on (date, workoutType) pairs only. Exercises are
 * deliberately NOT compared: selection varies with planHistory (variety
 * scoring), and a heal triggered by exercise differences would rewrite
 * healthy rows on every open. Dates + types are what corruption breaks.
 */
export function weekRowMatchesCanonical(
  stored: ReadonlyArray<{ date?: string | null; workoutType?: string | null }> | null | undefined,
  canonical: ReadonlyArray<{ date?: string | null; workoutType?: string | null }>,
): boolean {
  if (!stored) return false;
  const sig = (days: ReadonlyArray<{ date?: string | null; workoutType?: string | null }>) =>
    days
      .map(d => `${d?.date ?? ''}|${d?.workoutType ?? ''}`)
      .sort()
      .join(',');
  return sig(stored) === sig(canonical);
}

export interface HealResult {
  /** true when the stored row deviated and `days` is a fresh canonical week. */
  healed: boolean;
  days: PlanDay[];
}

/**
 * Validate a stored active-week row against the canonical derivation;
 * return the corrected week when it deviates. Pure and idempotent:
 * healing the healed output returns `healed: false` with the same days,
 * and a row that already matches is returned untouched (so in-progress
 * exercise selections survive).
 */
export function healCurrentWeekRow(
  storedDays: PlanDay[] | null | undefined,
  args: CanonicalWeekArgs,
): HealResult {
  const canonical = deriveCanonicalWeek(args);
  if (storedDays && weekRowMatchesCanonical(storedDays, canonical)) {
    return { healed: false, days: storedDays };
  }
  return { healed: true, days: canonical };
}
