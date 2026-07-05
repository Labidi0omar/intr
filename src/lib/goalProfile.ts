// Goal-aware programming dose — pure module.
//
// Consumes `profiles.goal` and the catalog's `movement` classification to
// shape the per-exercise reps / rest / sets that generatePlan emits, and to
// answer "what rep target for next session" given last session's performance.
//
// The three lanes:
//   strength — intensity-gated; heavy compounds low reps, accessories
//              still lower-rep than the other lanes. Sets stay flat within
//              a block; progression is load-only (top-of-band gate lives
//              in prescribeLoad).
//   muscle   — volume/effort-gated (hypertrophy). Higher reps, shorter
//              rest. Isolation sets climb across weeks 2-3 before deload
//              — that's the "add volume before load" pattern.
//   general  — PURE PASSTHROUGH. Existing/default users see NO change —
//              catalog reps, rest, and sets flow through unchanged. Only
//              strength and muscle shape the dose. This is intentional:
//              general is the "no explicit lane" state and shouldn't
//              silently re-programme a user who never asked for a change.
//
// Deload stacking: goal shapes the base dose, then deloadReps / deloadSets
// (blockWeek === 4) subtract from that. Rep strings stay in "X-Y" form so
// the existing deload regex still parses them.
//
// Rep strings that aren't a simple "X-Y" (the catalog has one edge case,
// "30-60s" for time-under-tension holds) pass through unchanged so the
// engine can't corrupt them.

export type Goal = 'strength' | 'muscle' | 'general';

export interface RepBand {
  min: number;
  max: number;
}

/** Parse a "X-Y" rep string into a numeric band. Returns null for anything
 *  else (single-number strings like "10", time-under-tension "30-60s",
 *  malformed input). Callers treat null as "leave the catalog value alone." */
export function parseBand(reps: string): RepBand | null {
  const m = reps.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return null;
  return { min, max };
}

function formatBand(min: number, max: number): string {
  return `${min}-${max}`;
}

// Per-lane target rep bands. Keyed on movement classification. `general`
// is intentionally absent — that lane is a pure passthrough (catalog
// values flow through unchanged).
const GOAL_REP_BANDS: Record<'strength' | 'muscle', { compound: RepBand; isolation: RepBand }> = {
  strength: {
    compound:  { min: 3, max: 5 },
    isolation: { min: 8, max: 10 },
  },
  muscle: {
    compound:  { min: 6, max: 10 },
    isolation: { min: 10, max: 15 },
  },
};

// Per-lane target rest (seconds). Same passthrough policy for `general`.
const GOAL_REST: Record<'strength' | 'muscle', { compound: number; isolation: number }> = {
  strength: { compound: 210, isolation: 120 },
  muscle:   { compound: 120, isolation: 75 },
};

function isKnownGoal(goal: unknown): goal is Goal {
  return goal === 'strength' || goal === 'muscle' || goal === 'general';
}

/** Rep band for (goal, movement), as an "X-Y" string. When the catalog rep
 *  isn't parseable (e.g. "30-60s") the catalog value passes through unchanged
 *  — we never overwrite an intentionally non-standard rep spec. `general`
 *  is a pure passthrough — catalog value returns unchanged. */
export function goalReps(catalogReps: string, goal: Goal | undefined | null, isCompound: boolean): string {
  if (!isKnownGoal(goal) || goal === 'general') return catalogReps;
  if (!parseBand(catalogReps)) return catalogReps;
  const band = GOAL_REP_BANDS[goal][isCompound ? 'compound' : 'isolation'];
  return formatBand(band.min, band.max);
}

/** Rest (seconds) for (goal, movement). Falls back to the catalog value for
 *  unknown goals AND for the `general` passthrough lane. */
export function goalRest(catalogRest: number, goal: Goal | undefined | null, isCompound: boolean): number {
  if (!isKnownGoal(goal) || goal === 'general') return catalogRest;
  return GOAL_REST[goal][isCompound ? 'compound' : 'isolation'];
}

/** Sets for (goal, movement, blockWeek). Volume-first for MUSCLE isolations
 *  only: catalog baseline in week 1, +1 in weeks 2 and 3, then deload
 *  (handled by the caller passing blockWeek=4 through deloadSets — this
 *  function returns the pre-deload baseline). Strength keeps sets flat
 *  across the block (strength progresses via load). General is a pure
 *  passthrough. Compounds stay flat on every lane — set climb on a heavy
 *  compound explodes session length without matching added stimulus.
 *
 *  blockWeek is 1..4 (same convention as planGeneration's loop). Values
 *  outside that range are clamped to 1 so the function stays total. */
export function goalSets(catalogSets: number, goal: Goal | undefined | null, isCompound: boolean, blockWeek = 1): number {
  if (!Number.isFinite(catalogSets) || catalogSets <= 0) return 1;
  if (!isKnownGoal(goal)) return catalogSets;
  // Only muscle isolations climb sets. Strength / general / compounds are
  // pass-through: return the catalog value unchanged.
  if (goal !== 'muscle') return catalogSets;
  if (isCompound) return catalogSets;
  const wk = blockWeek >= 1 && blockWeek <= 3 ? Math.floor(blockWeek) : 1;
  const climb = wk === 1 ? 0 : 1;
  return catalogSets + climb;
}

// ── Volume-first rep progression ─────────────────────────────────────────
//
// Session-to-session rep target for the next workout of a given lift. This
// is what turns a static catalog band into an actual progression: last time
// you hit 10 in an 8-12 band, this time aim for 11.
//
// Coupled with prescribeLoad's top-of-band gate (Part 3+4a):
//   - Weight is HELD until reps have topped the band cleanly.
//   - When reps topped AND effort was reasonable, the load bump fires AND
//     rep target resets to the bottom of the band for the next session.
//   - Failure day (RIR 0) holds both weight and reps — don't ratchet on a
//     grinded set.
//
// Pure — the caller reads history (last session's best set), we return the
// target. No I/O.

export interface NextVolumeStepInput {
  /** Best set's reps last session for this lift. Null / undefined → the
   *  presenter has no history to progress from; fall back to the catalog
   *  band's top as the aim. */
  lastReps?: number | null;
  /** Parsed band for the CURRENT plan entry (post-goalReps, post-deload).
   *  Callers use parseBand on the plan.exercise.reps string. */
  band: RepBand;
  goal: Goal | undefined | null;
  /** Effort signal on last session's best set. Null = unknown; treated as
   *  "not clean enough to progress reps." */
  lastRir?: number | null;
  isCompound: boolean;
}

export interface NextVolumeStep {
  /** The rep count to aim for on the top set of next session. Presenter
   *  can show "aim for X reps." */
  targetReps: number;
  /** True when last session hit the top of the band cleanly and reps are
   *  ready to reset to the bottom on a load bump. prescribeLoad reads
   *  this via its own top-of-band gate (`lastReps` + `topReps` inputs) —
   *  the flag here is what a presenter or the workout screen uses to
   *  decide whether to display "same reps, +2.5kg" vs "aim for X reps." */
  readyForLoadBump: boolean;
}

/** Compute next session's rep target for a lift, given last session's best
 *  set. Rules by lane:
 *
 *  strength: rep target is always the top of the band. Progression happens
 *    on load. readyForLoadBump when reps hit the top at target RIR (1, 2,
 *    or 3 on the strength lane — the full strength target range).
 *
 *  muscle: volume-first. Climb reps within the band before touching weight.
 *    - lastReps < band.max                → aim for lastReps + 1
 *    - lastReps ≥ band.max, RIR ≥ 1       → reset to band.min, ready to bump load
 *    - lastReps ≥ band.max, RIR === 0     → hold at band.max, NOT ready
 *      (grinded a rep; don't ratchet)
 *
 *  general / unknown goal / no history: aim for band.max as a sensible
 *  default. The general lane is otherwise a pass-through — the workout
 *  screen keeps its pre-goal behavior. */
export function nextVolumeStep(input: NextVolumeStepInput): NextVolumeStep {
  const { band, goal, lastRir, isCompound } = input;
  void isCompound;
  const lastReps = typeof input.lastReps === 'number' && Number.isFinite(input.lastReps)
    ? Math.floor(input.lastReps)
    : null;

  // Cap the returned target at band.max so we never display a target
  // higher than the plan's rep range on an outlier log.
  const clampToBand = (n: number) => Math.max(band.min, Math.min(band.max, n));

  if (!isKnownGoal(goal) || goal === 'strength' || goal === 'general') {
    if (lastReps == null) return { targetReps: band.max, readyForLoadBump: false };
    if (goal === 'strength') {
      // Strength: aim for the top of the band. Ready to bump when reps
      // hit top and last effort was in the strength target zone (RIR 1-3).
      const clean = lastRir === 1 || lastRir === 2 || lastRir === 3;
      return {
        targetReps: band.max,
        readyForLoadBump: lastReps >= band.max && clean,
      };
    }
    // General / unknown: aim for top of band; never claim a load-bump
    // readiness (the pass-through lane defers weight decisions to the
    // pre-goal engine — prescribeLoad's RIR ladder alone).
    return { targetReps: band.max, readyForLoadBump: false };
  }

  // Muscle only from here on — volume-first.
  if (lastReps == null) return { targetReps: band.max, readyForLoadBump: false };

  if (lastReps < band.max) {
    return { targetReps: clampToBand(lastReps + 1), readyForLoadBump: false };
  }

  // lastReps >= band.max. Grinded (RIR 0) → hold; clean or unknown-but-hit-top
  // → ready to bump load and reset reps to band.min for a fresh start.
  if (lastRir === 0) {
    return { targetReps: band.max, readyForLoadBump: false };
  }
  return { targetReps: band.min, readyForLoadBump: true };
}
