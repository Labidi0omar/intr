// Pure week-progress accounting. Lives in its own file (no react-native /
// supabase / async-storage imports) so jest can load it under the node
// test environment.
//
// The rule, learned from a real-device bug:
//   A day counts as a completed TRAINING day ONLY when there is a
//   completed, NON-recovery session AND that weekday was a PLANNED
//   training day in this week's plan. A rest-day workout (is_recovery=true,
//   or a session on a day with workoutType='Rest') must not bump the
//   "X of Y completed" count or the week-strip dots.

import { plannedTrainingDatesInWeek } from './planShift';

const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** Convert a YYYY-MM-DD string to its English weekday name in LOCAL time.
 *  Returns null on malformed input (the caller's set won't grow). */
export function dayNameFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parts = iso.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return DAY_NAMES[d.getDay()] ?? null;
}

export interface WeekSessionRow {
  planned_date?: string | null;
  is_recovery?: boolean | null;
  /** Belt-and-suspenders: legacy rows that predate the column may carry the
   *  tag in workout_type as 'Recovery — …'. */
  workout_type?: string | null;
}

export interface PlanDayLike {
  day?: string | null;
  /** Explicit calendar date set by generatePlan. Preferred over .day when
   *  resolving "is this a planned training date" — see
   *  plannedTrainingDatesInWeek in ./planShift. */
  date?: string | null;
  workoutType?: string | null;
}

/** Day names that the plan marks as actual training days (workoutType !=
 *  'Rest' and not a recovery type). */
export function plannedTrainingDayNames(planDays: readonly PlanDayLike[]): Set<string> {
  const out = new Set<string>();
  for (const d of planDays ?? []) {
    if (!d?.day) continue;
    const t = d.workoutType ?? '';
    if (!t) continue;
    if (t === 'Rest') continue;
    if (t.startsWith('Recovery')) continue;
    out.add(d.day);
  }
  return out;
}

/** True iff a session row should be counted as recovery (and therefore
 *  excluded from training-progress accounting). */
function sessionIsRecovery(row: WeekSessionRow): boolean {
  if (row.is_recovery === true) return true;
  if (typeof row.workout_type === 'string' && row.workout_type.startsWith('Recovery')) {
    return true;
  }
  return false;
}

/**
 * Set of weekday names (Monday / Tuesday / …) that count as a completed
 * training day this week. A row contributes ONLY when:
 *
 *   1. it is not a recovery session (so a rest-day mobility/cardio flow
 *      can't inflate the count), AND
 *   2. its planned_date matches one of the plan's training days for this
 *      week (so a real workout that happened on what the plan calls a
 *      rest day doesn't inflate either — that scenario is a missed-day
 *      question, not a planned-day completion).
 *
 * Date resolution: when `weekStartIso` is provided, matching is anchored
 * on each PlanDay's calendar date (.date preferred, weekStart + offset
 * fallback). Without weekStartIso the matcher falls back to the legacy
 * weekday-name comparison — preserved so older call sites don't need to
 * thread weekStart through, but new code (home dashboard, gap modal,
 * missed modal) should always pass weekStartIso so a mid-week onboarder
 * whose "Monday" entry means "next Monday" doesn't cross-pollinate this
 * week's Monday session into the completion set.
 *
 * The same set drives both the "X of Y" card number and the week-strip
 * dots so the two can never disagree on screen.
 */
export function computeCompletedTrainingDays(
  weekSessions: readonly WeekSessionRow[],
  planDays: readonly PlanDayLike[],
  weekStartIso?: string,
): Set<string> {
  const out = new Set<string>();
  if (weekStartIso) {
    const plannedDates = plannedTrainingDatesInWeek(planDays, weekStartIso);
    for (const s of weekSessions ?? []) {
      if (sessionIsRecovery(s)) continue;
      if (!s.planned_date) continue;
      if (!plannedDates.has(s.planned_date)) continue;
      const name = dayNameFromIso(s.planned_date);
      if (!name) continue;
      out.add(name);
    }
    return out;
  }
  // Legacy path: weekday-name comparison only.
  const planned = plannedTrainingDayNames(planDays);
  for (const s of weekSessions ?? []) {
    if (sessionIsRecovery(s)) continue;
    const name = dayNameFromIso(s.planned_date);
    if (!name) continue;
    if (!planned.has(name)) continue;
    out.add(name);
  }
  return out;
}
