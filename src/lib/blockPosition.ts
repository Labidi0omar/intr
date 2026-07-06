// Single source of truth for turning a calendar-week distance into a
// mesocycle (blockIndex, blockWeek) position — with the "earned deload"
// gate applied inside.
//
// THE ROOT CAUSE THIS MODULE EXISTS TO FIX
// ─────────────────────────────────────────
// Before this helper, every materialization site (planSync + planCatchUp)
// computed its own position from the calendar:
//     blockIndex = floor(weeksFromAnchor / 4)
//     blockWeek  = (weeksFromAnchor % 4) + 1
// which meant a user who did NOT train for four calendar weeks still rolled
// into `blockWeek === 4`, generatePlan stamped `deload: true`, and the
// active row was written as a "recovery week" against a block that never
// happened. A 2-week layoff doesn't need reduced-set recovery volume — it
// needs a fresh block.
//
// This module wraps the calendar formula in one place so we can layer the
// earned-deload check on top consistently. Every write path funnels through
// resolveBlockPosition and can't disagree.
//
// The gate:
//   - blockCompletedSessions ≥ DELOAD_EARN_FLOOR → real week-4 deload
//   - blockCompletedSessions < DELOAD_EARN_FLOOR → reset to (blockIndex+1, 1)
// Weeks 1–3 always pass through unchanged (the gate is a deload-week concern
// only). The reset advances `blockIndex` by one so the seeded picker
// reshuffles exercise selection — that's the intended "fresh start" for a
// layoff-broken block.
//
// Pure. Deterministic. Never throws.

/**
 * Completed non-recovery sessions required in the current block's weeks 1–3
 * before its calendar week-4 becomes a real, materialized deload. Below
 * this floor the block was not actually trained and the deload is unearned;
 * we roll to a fresh block instead of forcing a "recovery" week that has
 * nothing to recover from.
 *
 * Same floor value as `DELOAD_TRAINING_FLOOR` in trainingStatus.ts
 * (deload-offer gate). Kept as a separate export because the deload-OFFER
 * gate reads recent (2-week) sessions while this one reads block-scoped
 * sessions — the number happens to be the same but the semantics differ.
 * Duplicating the constant means either can be tuned independently.
 */
export const DELOAD_EARN_FLOOR = 3;

export interface BlockPositionInput {
  /** Integer weeks between the plan anchor and the target week's week_start.
   *  Non-negative — a negative value collapses to 0. */
  weeksFromAnchor: number;
  /** Count of completed non-recovery sessions with planned_date inside the
   *  current block's weeks 1–3 window. When omitted (legacy callers that
   *  haven't been wired) the earned check is SKIPPED and the raw calendar
   *  position is returned — preserves pre-fix behavior. */
  blockCompletedSessions?: number;
}

export interface BlockPosition {
  blockIndex: number;
  blockWeek: 1 | 2 | 3 | 4;
}

/**
 * Turn calendar distance into a mesocycle position, applying the earned-
 * deload gate. This is the ONLY function that decides whether a given
 * week is a deload — every materialization site (planSync's main loop,
 * planCatchUp's canonical derivation and resume packer, the cache
 * refresh) must funnel through here.
 *
 * @example Idle user rolling into calendar week 4
 *   resolveBlockPosition({ weeksFromAnchor: 3, blockCompletedSessions: 0 })
 *   → { blockIndex: 1, blockWeek: 1 }  ← reset, not deload
 *
 * @example Trained user rolling into calendar week 4
 *   resolveBlockPosition({ weeksFromAnchor: 3, blockCompletedSessions: 5 })
 *   → { blockIndex: 0, blockWeek: 4 }  ← real deload
 *
 * @example Any calendar week 1–3 (unaffected by the gate)
 *   resolveBlockPosition({ weeksFromAnchor: 1, blockCompletedSessions: 0 })
 *   → { blockIndex: 0, blockWeek: 2 }
 */
export function resolveBlockPosition(input: BlockPositionInput): BlockPosition {
  const weeks = Math.max(0, Math.floor(Number.isFinite(input.weeksFromAnchor) ? input.weeksFromAnchor : 0));
  const rawIndex = Math.floor(weeks / 4);
  const rawWeek = ((weeks % 4) + 1) as 1 | 2 | 3 | 4;

  // Weeks 1–3 always pass through — the gate is a deload-week concern.
  if (rawWeek !== 4) return { blockIndex: rawIndex, blockWeek: rawWeek };

  // Legacy path: caller didn't wire blockCompletedSessions. Preserve raw
  // calendar behavior so untouched callers see no change. The tests in
  // the wired sites (planSync, planCatchUp) prove the gate fires when the
  // count IS provided; a missing count collapses to no-op.
  const done = input.blockCompletedSessions;
  if (done == null || !Number.isFinite(done)) {
    return { blockIndex: rawIndex, blockWeek: rawWeek };
  }

  if (done < DELOAD_EARN_FLOOR) {
    // Unearned deload — the block was NOT actually trained. Reset to the
    // start of the next block. blockIndex+1 reshuffles the seeded picker
    // (fresh exercise selection is the point of "fresh start"); blockWeek 1
    // gives normal base volume instead of reduced deload dose.
    return { blockIndex: rawIndex + 1, blockWeek: 1 };
  }

  // Earned deload — real recovery week.
  return { blockIndex: rawIndex, blockWeek: 4 };
}
