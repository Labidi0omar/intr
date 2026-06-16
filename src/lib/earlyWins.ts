// Early small-win — the earliest HONEST progress signal a new user can see,
// during the calibration window before the recovery gauge / strength trend
// become meaningful.
//
// It reads the same per-lift session-top history the coach's lift_progression
// observation reads (see buildLiftProgression in coachObservations.ts), and
// counts the lifts whose MOST RECENT logged session beat the one before it —
// a real "you added weight" event, by session ~2–3. It never fabricates a
// number: a fresh account with nothing logged (or no lift trained twice yet)
// returns show:false, so the UI shows nothing rather than a misleading "0".
//
// Reconciliation with the coach: the coach names a single lift ("Bench is
// climbing — 60→65 kg"); this surfaces only the AGGREGATE count ("added
// weight on 2 lifts this week") as a dashboard reassurance. Same underlying
// truth, complementary framing — not the same fact stated twice the same way.
//
// Pure & deterministic: no React, no Supabase. Never throws.

import type { LiftSessionTop } from './coachObservations';

export interface EarlyWin {
  /** Distinct lifts whose latest session top weight exceeded the immediately
   *  prior session's top, within the recent window. */
  liftsImproved: number;
  /** Whether there is a genuine win worth surfacing (liftsImproved >= 1).
   *  False on a fresh account — render nothing, never "0". */
  show: boolean;
}

/** How fresh the improving session must be to read as "this week". A lift
 *  whose last increase was longer ago than this is stale and not counted. */
const DEFAULT_RECENT_DAYS = 9;

/** Absolute day distance between two local YYYY-MM-DD dates. */
function daysBetween(aIso: string, bIso: string): number {
  const pa = aIso.split('-').map(Number);
  const pb = bIso.split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3) return Number.POSITIVE_INFINITY;
  const da = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
  const db = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(db - da) / 86400000);
}

/**
 * Count the lifts the user genuinely added weight on recently.
 *
 * @param liftSessions  exercise name -> session tops, OLDEST-FIRST (the order
 *                      home.tsx already sorts them into). Each entry is the
 *                      max numeric kg for that lift in one session.
 * @param opts.todayIso when provided, an improving session older than
 *                      recentDays is treated as stale and excluded.
 */
export function computeEarlyWins(
  liftSessions: Record<string, LiftSessionTop[]>,
  opts: { todayIso?: string; recentDays?: number } = {},
): EarlyWin {
  const recentDays = opts.recentDays ?? DEFAULT_RECENT_DAYS;
  if (!liftSessions || typeof liftSessions !== 'object') {
    return { liftsImproved: 0, show: false };
  }

  let liftsImproved = 0;
  for (const lift of Object.keys(liftSessions)) {
    const arr = liftSessions[lift];
    // Need at least two real sessions to have "added weight" between them.
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const last = arr[arr.length - 1];
    const prev = arr[arr.length - 2];
    if (!last || !prev) continue;
    if (!Number.isFinite(last.topKg) || !Number.isFinite(prev.topKg)) continue;
    // Only count fresh increases so the "this week" copy stays honest.
    if (opts.todayIso && last.date && daysBetween(last.date, opts.todayIso) > recentDays) continue;
    if (last.topKg > prev.topKg) liftsImproved++;
  }

  return { liftsImproved, show: liftsImproved > 0 };
}
