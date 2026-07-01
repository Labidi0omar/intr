// Pure date resolution + unfinished-day detection for the GapModal
// "catch-up" resume flow. Lives in its own file (no React Native /
// Supabase imports) so jest can load it without the @react-native ESM
// transform fight. gapDetection.ts re-exports the public surface so
// existing call sites keep working.
//
// History: this file previously housed shiftMissedForward (within-week
// reslot) and shiftPlanForward (rigid forward shift) — both removed when
// the resume flow switched to regenerating a catch-up pack from
// generatePlan (see src/utils/planCatchUp.ts). The remaining helpers
// (resolvePlanDayDate, plannedTrainingDatesInWeek, the unfinished-day
// scans) still drive the dashboard's date-anchored reads.

export const WEEKDAY_OFFSET: Record<string, number> = {
  Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3,
  Friday: 4, Saturday: 5, Sunday: 6,
};

/**
 * Resolve a PlanDay's calendar date. Prefers the explicit `.date` set by
 * generatePlan (source of truth); falls back to weekStart + WEEKDAY_OFFSET
 * for legacy plans without it. Returns null when neither resolution is
 * possible (unknown weekday and no `.date`).
 *
 * Exported so callers outside this file can match the same date-resolution
 * rule findMissedPlanDays / shiftMissedForward use internally.
 */
export function resolvePlanDayDate(
  d: { day?: string | null; date?: string | null } | null | undefined,
  weekStartIso: string,
): string | null {
  if (!d) return null;
  if (d.date) return d.date;
  if (!d.day) return null;
  const off = WEEKDAY_OFFSET[d.day];
  if (off === undefined) return null;
  return dateAddDays(weekStartIso, off);
}

/**
 * Single date-anchored "what's on the plan for this calendar date" resolver.
 * Replaces the weekday-name lookup (planDays.find(d => d.day === 'Monday'))
 * that drifted out of sync with the calendar for mid-week onboarders whose
 * "Monday" entry actually meant "next Monday."
 *
 * Returns the first PlanDay whose resolved date equals targetDateIso, or
 * null when nothing planned covers that date. Pure; safe to call from any
 * surface that needs today's (or any date's) workout type.
 */
export function resolvePlanDayForDate<T extends { day?: string | null; date?: string | null }>(
  planDays: readonly T[] | null | undefined,
  weekStartIso: string,
  targetDateIso: string,
): T | null {
  if (!planDays) return null;
  for (const d of planDays) {
    const resolved = resolvePlanDayDate(d, weekStartIso);
    if (resolved === targetDateIso) return d;
  }
  return null;
}

/** Tri-valued read of "what kind of day is today." Used to fan out one
 *  source of truth across the dashboard's three rest-day decisions (the
 *  TODAY card, the coach hero, the observation pipeline) so they can
 *  never disagree on screen.
 *
 *  Core rule: absence of a resolved plan day is UNKNOWN, not REST. Only
 *  positively-resolved rest/recovery designation produces 'rest'. The
 *  coach hero treats 'unknown' as "suppress" — it never asserts "Rest
 *  today" from a transient load race.
 */
export type TodayKind = 'training' | 'rest' | 'unknown';

/**
 * Derive today's kind from the same resolved plan the TODAY card renders
 * from. Pure; null-safe.
 *
 *   'unknown' — planDays not loaded (null/empty), or weekStart missing.
 *   'rest'    — planDays IS loaded AND today positively has no training
 *               row (no match in the array) OR matches a row whose
 *               workoutType is empty / 'Rest' / 'Recovery*'.
 *   'training' — today matches a row whose workoutType names a real
 *               training session (anything else).
 */
export function deriveTodayKind(
  planDays:
    | readonly { day?: string | null; date?: string | null; workoutType?: string | null }[]
    | null
    | undefined,
  weekStartIso: string | null | undefined,
  todayIso: string,
): TodayKind {
  // Plan not loaded yet → unknown. This is THE bug fix: a transient null
  // from an in-flight fetch must NEVER read as rest day.
  if (!planDays || planDays.length === 0) return 'unknown';
  if (!weekStartIso) return 'unknown';

  const todayPlan = resolvePlanDayForDate(planDays, weekStartIso, todayIso);
  // PlanDays loaded but nothing maps to today → genuine rest day (the
  // plan's gaps are rest by construction).
  if (!todayPlan) return 'rest';

  const wt = (todayPlan.workoutType ?? '').trim();
  if (!wt) return 'rest';
  if (wt === 'Rest') return 'rest';
  if (wt.startsWith('Recovery')) return 'rest';
  return 'training';
}

/**
 * Set of ISO dates (YYYY-MM-DD) the plan marks as actual training days
 * within [weekStart, weekStart+6]. Excludes Rest and Recovery-prefixed
 * workout types so consumers don't have to re-filter. Date-anchored so a
 * mid-week onboarder's "Monday" entry (whose .date points to next Monday)
 * doesn't collide with this week's Monday in completion accounting.
 */
export function plannedTrainingDatesInWeek(
  planDays: readonly { day?: string | null; date?: string | null; workoutType?: string | null }[] | null | undefined,
  weekStartIso: string,
): Set<string> {
  const out = new Set<string>();
  if (!planDays) return out;
  for (const d of planDays) {
    const wt = d?.workoutType ?? '';
    if (!wt) continue;
    if (wt === 'Rest') continue;
    if (wt.startsWith('Recovery')) continue;
    const resolved = resolvePlanDayDate(d, weekStartIso);
    if (resolved) out.add(resolved);
  }
  return out;
}

/** weekStart (Monday) + n days → YYYY-MM-DD (local). */
function dateAddDays(weekStartIso: string, days: number): string {
  const p = weekStartIso.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Days between two YYYY-MM-DD strings (local), integer. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = fromIso.split('-').map(Number);
  const b = toIso.split('-').map(Number);
  const aMs = new Date(a[0], a[1] - 1, a[2]).getTime();
  const bMs = new Date(b[0], b[1] - 1, b[2]).getTime();
  return Math.round((bMs - aMs) / 86400000);
}

/** Public: integer days between two YYYY-MM-DD strings. Same semantics as
 *  the internal helper — exposed so callers can compute a shift offset
 *  without re-implementing the local-time math. */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  return daysBetween(fromIso, toIso);
}

/**
 * Result of scanning multiple weekly_plans rows for the earliest unfinished
 * past planned training day. Used by the gap-detection block in home.tsx
 * to surface the GapModal whenever an unresolved past training day exists.
 */
export interface UnfinishedTrainingAnchor {
  /** Calendar date of the earliest unfinished planned training day. */
  earliestDate: string;
  /** week_start of the weekly_plans row containing that earliest day —
   *  the row from which the rigid-shift cascade starts. */
  rowWeekStart: string;
  /** today − earliestDate (positive, > 0). */
  offsetDays: number;
}

/**
 * Pure, multi-row scan: find the earliest unfinished planned TRAINING day
 * (not Rest, not Recovery) whose resolved date is strictly before
 * `todayIso` and has no completed non-recovery session on that exact date
 * in `completedDates`. Returns null when nothing qualifies.
 *
 * This is the anchor for Fix A: a missed leg day stranded in an earlier
 * weekly_plans row must surface as the shift anchor even when today's
 * row already exists. The legacy current-week-only computation collapsed
 * to offset 0 in that scenario because the current row had no missed
 * days of its own.
 *
 * Date matching for "is this day completed" is by ISO date — same rule
 * the dashboard uses for completed-training-day accounting. Recovery
 * sessions are the caller's responsibility to filter out before passing
 * `completedDates` in.
 *
 * The helper is idempotent in the sense the cascade requires: once every
 * unfinished planned training day has been pushed to today-or-future
 * (which is what the shift achieves), the next call returns null and the
 * resume action becomes a no-op.
 */
export function findEarliestUnfinishedTrainingDay(
  rows: ReadonlyArray<{
    weekStart: string;
    planDays: ReadonlyArray<{ day?: string | null; date?: string | null; workoutType?: string | null }>;
  }>,
  todayIso: string,
  completedDates: ReadonlySet<string>,
  /** Resolution watermark — any planned date ≤ this ISO string is
   *  treated as resolved (either picked up or skipped) by a prior
   *  GapModal action and never re-anchors the scan. Optional; when
   *  omitted the scan considers every past unfinished day. */
  resolvedThroughIso?: string | null,
): UnfinishedTrainingAnchor | null {
  let best: { date: string; weekStart: string } | null = null;
  for (const row of rows) {
    for (const d of row.planDays) {
      const wt = d?.workoutType ?? '';
      if (!wt) continue;
      if (wt === 'Rest') continue;
      if (wt.startsWith('Recovery')) continue;
      const resolved = resolvePlanDayDate(d, row.weekStart);
      if (!resolved) continue;
      if (resolved >= todayIso) continue;
      if (resolvedThroughIso && resolved <= resolvedThroughIso) continue;
      if (completedDates.has(resolved)) continue;
      if (best === null || resolved < best.date) {
        best = { date: resolved, weekStart: row.weekStart };
      }
    }
  }
  if (best === null) return null;
  const offsetDays = daysBetween(best.date, todayIso);
  if (offsetDays <= 0) return null;
  return {
    earliestDate: best.date,
    rowWeekStart: best.weekStart,
    offsetDays,
  };
}

/**
 * Single day-level gate for BOTH GapModal trigger paths: returns true when
 * the gap modal is allowed to surface today, false when a prior ackGap
 * press already resolved the gap through today (watermark ≥ today).
 *
 * Why this exists: ackGap writes only the `gap:resolvedThrough` watermark.
 * The anchor scan honors it per-date, but the legacy detectReturnGap
 * fallback used to be gated only by a per-day ack key that ackGap never
 * wrote — so for accounts whose gap is detected via the fallback (e.g.
 * long-dormant accounts with no unfinished days inside the survey window)
 * the modal re-fired on every focus after the user acted. Gating both
 * paths on this helper makes one ackGap press sufficient to silence the
 * modal for the day, whichever path detected the gap. A secondary guard
 * (the legacy ack key) may still apply on top; this gate is the one that
 * must hold.
 */
export function shouldShowGapModalToday(
  todayIso: string,
  resolvedThroughIso: string | null | undefined,
): boolean {
  return !(resolvedThroughIso && resolvedThroughIso >= todayIso);
}

/**
 * Count every planned training day across the surveyed rows whose
 * resolved date is < today and that has no matching completed
 * non-recovery session date. Sister helper to
 * findEarliestUnfinishedTrainingDay — same exclusion rules, returns just
 * the count. Drives the backlog N for the catch-up pack generator.
 *
 * `resolvedThroughIso` is the GapModal resolution watermark: any planned
 * date ≤ that ISO string is treated as resolved and not counted. Without
 * the watermark the modal would re-fire on every focus because the catch-
 * up rewrite never touches the past-week rows that hold the stranded
 * misses. With it, "you missed N days" stops nagging after the user acts
 * but a genuinely new miss on a LATER date still counts.
 *
 * Counting is per unique CALENDAR DATE, not per PlanDay entry. Corrupted
 * stores can hold two rows whose 7-day windows overlap, putting two
 * PlanDay entries on the same date — counting entries would inflate the
 * backlog and make the catch-up pack generate phantom make-up sessions.
 * One date missed = one session owed, whatever the row shape.
 */
export function countUnfinishedPastTrainingDays(
  rows: ReadonlyArray<{
    weekStart: string;
    planDays: ReadonlyArray<{ day?: string | null; date?: string | null; workoutType?: string | null }>;
  }>,
  todayIso: string,
  completedDates: ReadonlySet<string>,
  resolvedThroughIso?: string | null,
): number {
  const missedDates = new Set<string>();
  for (const row of rows) {
    for (const d of row.planDays) {
      const wt = d?.workoutType ?? '';
      if (!wt) continue;
      if (wt === 'Rest') continue;
      if (wt.startsWith('Recovery')) continue;
      const resolved = resolvePlanDayDate(d, row.weekStart);
      if (!resolved) continue;
      if (resolved >= todayIso) continue;
      if (resolvedThroughIso && resolved <= resolvedThroughIso) continue;
      if (completedDates.has(resolved)) continue;
      missedDates.add(resolved);
    }
  }
  return missedDates.size;
}

/** AsyncStorage key for the GapModal resolution watermark — "every planned
 *  date on or before the stored ISO is resolved (resumed or skipped)."
 *  Written by ackGap in app/(tabs)/home.tsx; read by the gap scan there and
 *  by planSync's active-week self-heal (a fresh resume/skip rewrite must not
 *  be clobbered by the heal on the very next focus). Single definition so
 *  the two sides can't drift. */
export function gapResolvedThroughKey(userId: string): string {
  return `gap:resolvedThrough:${userId}`;
}

