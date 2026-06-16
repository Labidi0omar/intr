import { supabase } from '../lib/supabase';
import { reportSilent } from '../lib/errorReporting';

// Day states used by the month-view modal on the Home tab. Mirrors the
// vocabulary of WeekStrip ('completed' | 'missed' | 'planned' | 'rest') plus
// a fifth 'unknown' value reserved for dates with no weekly_plans row covering
// them yet (typically future weeks the auto-regen hasn't materialised). The
// honesty rule: never fabricate a state for unknown dates — render the date
// number only.
export type MonthDayState =
  | 'completed'
  | 'missed'
  | 'planned'
  | 'rest'
  | 'unknown';

export interface MonthDay {
  date: string;        // YYYY-MM-DD (local)
  dayOfMonth: number;  // 1..31
  inMonth: boolean;    // false = leading/trailing padding cell from sibling month
  isToday: boolean;
  state: MonthDayState;
  /** From the covering weekly_plans row, when present. Used by the per-day summary. */
  workoutType?: string;
}

const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

function iso(y: number, m1: number, d: number): string {
  return `${y}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Local-time YYYY-MM-DD for "today". */
function todayIso(): string {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

/** weekStart (Monday) + days → iso string (local). */
function addDaysIso(weekStart: string, days: number): string {
  const p = weekStart.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + days);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * Build a 42-cell month grid (6 rows × 7 cols, Sunday-start) for the given
 * year + monthIndex (0..11). Leading/trailing cells from the adjacent months
 * are included with `inMonth: false` so the caller can render a stable grid.
 *
 * Read-only. Tolerates missing data — empty accounts get a fully 'unknown'
 * month grid rather than a crash.
 */
export async function getMonthCalendar(
  userId: string,
  year: number,
  monthIndex: number, // 0..11
): Promise<MonthDay[]> {
  // ── Grid bounds (Sunday-start; pad leading + trailing) ─────────────
  const firstOfMonth = new Date(year, monthIndex, 1);
  const firstDow = firstOfMonth.getDay(); // 0..6, 0=Sunday
  const gridStart = new Date(year, monthIndex, 1 - firstDow);
  const cells: MonthDay[] = [];
  const todayStr = todayIso();

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    cells.push({
      date: iso(d.getFullYear(), d.getMonth() + 1, d.getDate()),
      dayOfMonth: d.getDate(),
      inMonth: d.getMonth() === monthIndex,
      isToday: iso(d.getFullYear(), d.getMonth() + 1, d.getDate()) === todayStr,
      state: 'unknown',
    });
  }

  const rangeStart = cells[0].date;
  const rangeEnd = cells[cells.length - 1].date;

  // ── Completed sessions in range ────────────────────────────────────
  let completedDates = new Set<string>();
  try {
    const { data: sessions } = await supabase
      .from('workout_sessions')
      .select('planned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('planned_date', rangeStart)
      .lte('planned_date', rangeEnd);
    completedDates = new Set((sessions ?? []).map((s: any) => s.planned_date));
  } catch (e) {
    // Tolerate; cells stay 'unknown'.
    reportSilent(e, 'monthCalendar:fetchPlans');
  }

  // ── Weekly plans whose week could cover any day in range ──────────
  // A row covers a date iff week_start <= date <= week_start + 6.
  // Pull rows with week_start within [rangeStart - 7 days, rangeEnd] to
  // catch the row that owns the leading edge of the grid.
  const sevenBeforeRange = addDaysIso(rangeStart, -7);
  type PlanRow = { week_start: string; plan: any };
  let planRows: PlanRow[] = [];
  try {
    const { data } = await supabase
      .from('weekly_plans')
      .select('week_start, plan')
      .eq('user_id', userId)
      .gte('week_start', sevenBeforeRange)
      .lte('week_start', rangeEnd);
    planRows = (data ?? []) as PlanRow[];
  } catch (e) {
    // Tolerate.
    reportSilent(e, 'monthCalendar:planRowsForward');
  }

  // ── Index plans by week ─────────────────────────────────────────────
  // Two lookups per week:
  //   - byDate: explicit calendar date → workoutType (preferred; set by
  //     generatePlan for new plans).
  //   - byDayName: weekday name → workoutType (legacy fallback for plans
  //     persisted before PlanDay.date existed).
  type WeekIndex = {
    weekStart: string;
    weekEnd: string;
    byDate: Map<string, string>;
    byDayName: Map<string, string>;
  };
  const weeks: WeekIndex[] = planRows.map(row => {
    const days: any[] = Array.isArray(row.plan?.days)
      ? row.plan.days
      : Array.isArray(row.plan) ? row.plan : [];
    const byDate = new Map<string, string>();
    const byDayName = new Map<string, string>();
    for (const d of days) {
      if (d?.date) byDate.set(d.date, d.workoutType ?? '');
      if (d?.day) byDayName.set(d.day, d.workoutType ?? '');
    }
    return {
      weekStart: row.week_start,
      weekEnd: addDaysIso(row.week_start, 6),
      byDate,
      byDayName,
    };
  });

  // ── Derive each cell's state ───────────────────────────────────────
  for (const cell of cells) {
    const p = cell.date.split('-').map(Number);
    const localDate = new Date(p[0], p[1] - 1, p[2]);
    const dayName = DAY_NAMES[localDate.getDay()];
    const covering = weeks.find(w => cell.date >= w.weekStart && cell.date <= w.weekEnd);
    // Prefer the explicit-date lookup (post-fix plans); fall back to weekday
    // name (legacy plans). Either is undefined when this date isn't planned.
    const plannedWorkoutType = covering
      ? (covering.byDate.get(cell.date) ?? covering.byDayName.get(dayName))
      : undefined;
    // Surface the workout type whenever a plan covers this date (regardless
    // of completion), so the per-day summary in the modal works.
    if (plannedWorkoutType !== undefined) cell.workoutType = plannedWorkoutType;

    if (completedDates.has(cell.date)) {
      cell.state = 'completed';
    } else if (!covering) {
      // No plan row covers this date — honest 'unknown'. Don't invent.
      cell.state = 'unknown';
    } else if (plannedWorkoutType !== undefined) {
      cell.state = cell.date < todayStr ? 'missed' : 'planned';
    } else {
      cell.state = 'rest';
    }
  }

  return cells;
}

// ── 30-day forward view ────────────────────────────────────────────────
// Simpler shape than the month grid: a flat list of the next 30 days
// starting today. No padding cells, no inMonth bookkeeping, no past.
// Used by the Home tab "next 30 days" modal.

export interface ForwardDay {
  date: string;        // YYYY-MM-DD
  dayOfMonth: number;
  weekdayShort: string;     // e.g. "Mon"
  monthShort: string;       // e.g. "Jun"
  isToday: boolean;
  /**
   * Same vocabulary as MonthDayState minus 'missed' — by construction this
   * list starts today, so no day is in the past and nothing can be missed.
   */
  state: 'completed' | 'planned' | 'rest' | 'unknown';
  workoutType?: string;
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The next 30 days starting today, with each day's plan state derived from
 * weekly_plans + workout_sessions. Read-only. Days past the latest stored
 * plan window render as 'unknown' — we never fabricate workouts.
 *
 * Day-state derivation:
 *   - completed: today's date appears in workout_sessions (completed=true)
 *                — only meaningful for the first cell (today), since the
 *                future hasn't happened yet
 *   - planned:   covered by a weekly_plans row AND the row schedules a
 *                workout for that calendar date (prefers PlanDay.date,
 *                falls back to weekStart + WEEKDAY_OFFSET[day])
 *   - rest:      covered by a weekly_plans row but not scheduled
 *   - unknown:   no plan row covers this date yet
 */
export async function get30DayPlan(userId: string): Promise<ForwardDay[]> {
  const now = new Date();
  const todayStr = iso(now.getFullYear(), now.getMonth() + 1, now.getDate());

  // Build the 30-day window.
  const days: ForwardDay[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const dateStr = iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
    days.push({
      date: dateStr,
      dayOfMonth: d.getDate(),
      weekdayShort: WEEKDAYS_SHORT[d.getDay()],
      monthShort: MONTHS_SHORT[d.getMonth()],
      isToday: dateStr === todayStr,
      state: 'unknown',
    });
  }

  const rangeStart = days[0].date;
  const rangeEnd = days[days.length - 1].date;

  // ── Completed sessions (only "today" can realistically be completed in
  //    this window; the rest of the window is the future) ────────────────
  let completedDates = new Set<string>();
  try {
    const { data: sessions } = await supabase
      .from('workout_sessions')
      .select('planned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('planned_date', rangeStart)
      .lte('planned_date', rangeEnd);
    completedDates = new Set((sessions ?? []).map((s: any) => s.planned_date));
  } catch (e) {
    // Tolerate.
    reportSilent(e, 'monthCalendar:completedSessions');
  }

  // ── Weekly plans whose coverage window touches the next 30 days ───────
  // A row covers a date iff week_start <= date <= week_start + 6.
  const sevenBeforeRange = addDaysIso(rangeStart, -7);
  type PlanRow = { week_start: string; plan: any };
  let planRows: PlanRow[] = [];
  try {
    const { data } = await supabase
      .from('weekly_plans')
      .select('week_start, plan')
      .eq('user_id', userId)
      .gte('week_start', sevenBeforeRange)
      .lte('week_start', rangeEnd);
    planRows = (data ?? []) as PlanRow[];
  } catch (e) {
    // Tolerate.
    reportSilent(e, 'monthCalendar:planRowsMonth');
  }

  // Index plans for both date-based (preferred) and weekday-name lookup.
  type WeekIndex = {
    weekStart: string;
    weekEnd: string;
    byDate: Map<string, string>;
    byDayName: Map<string, string>;
  };
  const weeks: WeekIndex[] = planRows.map(row => {
    const dayList: any[] = Array.isArray(row.plan?.days)
      ? row.plan.days
      : Array.isArray(row.plan) ? row.plan : [];
    const byDate = new Map<string, string>();
    const byDayName = new Map<string, string>();
    for (const d of dayList) {
      if (d?.date) byDate.set(d.date, d.workoutType ?? '');
      if (d?.day) byDayName.set(d.day, d.workoutType ?? '');
    }
    return {
      weekStart: row.week_start,
      weekEnd: addDaysIso(row.week_start, 6),
      byDate,
      byDayName,
    };
  });

  const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (const day of days) {
    const p = day.date.split('-').map(Number);
    const localDate = new Date(p[0], p[1] - 1, p[2]);
    const dayName = DOW_FULL[localDate.getDay()];
    const covering = weeks.find(w => day.date >= w.weekStart && day.date <= w.weekEnd);
    const plannedWt = covering
      ? (covering.byDate.get(day.date) ?? covering.byDayName.get(dayName))
      : undefined;
    if (plannedWt !== undefined) day.workoutType = plannedWt;

    if (completedDates.has(day.date)) {
      day.state = 'completed';
    } else if (!covering) {
      day.state = 'unknown';
    } else if (plannedWt !== undefined) {
      day.state = 'planned';
    } else {
      day.state = 'rest';
    }
  }

  return days;
}
