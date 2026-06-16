// Tests for the week-progress day-counter (Bug 1 reproduction).
//
// The shape under test: given a list of completed workout_sessions rows
// and the plan's days array, compute the set of weekday names that count
// as a completed TRAINING day this week. A rest-day mobility/cardio
// session (is_recovery=true) or a session on a day the plan marks as Rest
// must not show up in the set.

import {
  computeCompletedTrainingDays,
  dayNameFromIso,
  plannedTrainingDayNames,
  type PlanDayLike,
  type WeekSessionRow,
} from './weekProgress';

// Week of 2026-06-01 (Monday). The plan trains Mon/Wed/Fri.
const PLAN: PlanDayLike[] = [
  { day: 'Monday',    workoutType: 'Push' },
  { day: 'Tuesday',   workoutType: 'Rest' },
  { day: 'Wednesday', workoutType: 'Pull' },
  { day: 'Thursday',  workoutType: 'Rest' },
  { day: 'Friday',    workoutType: 'Legs' },
  { day: 'Saturday',  workoutType: 'Rest' },
  { day: 'Sunday',    workoutType: 'Rest' },
];

describe('dayNameFromIso', () => {
  it('returns the local weekday name', () => {
    // 2026-06-01 = Monday, 2026-06-04 = Thursday
    expect(dayNameFromIso('2026-06-01')).toBe('Monday');
    expect(dayNameFromIso('2026-06-04')).toBe('Thursday');
    expect(dayNameFromIso('2026-06-07')).toBe('Sunday');
  });

  it('returns null on bad input', () => {
    expect(dayNameFromIso(null)).toBeNull();
    expect(dayNameFromIso(undefined)).toBeNull();
    expect(dayNameFromIso('')).toBeNull();
    expect(dayNameFromIso('not-a-date')).toBeNull();
  });
});

describe('plannedTrainingDayNames', () => {
  it('returns only training days; Rest and Recovery types excluded', () => {
    expect(plannedTrainingDayNames(PLAN)).toEqual(
      new Set(['Monday', 'Wednesday', 'Friday']),
    );
  });

  it('drops Recovery-prefixed workoutTypes', () => {
    const plan: PlanDayLike[] = [
      { day: 'Monday', workoutType: 'Push' },
      { day: 'Tuesday', workoutType: 'Recovery — Mobility' },
    ];
    expect(plannedTrainingDayNames(plan)).toEqual(new Set(['Monday']));
  });
});

describe('computeCompletedTrainingDays', () => {
  it('counts a planned training day with a non-recovery completed session', () => {
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-01', is_recovery: false, workout_type: 'Push' }, // Monday
    ];
    expect(computeCompletedTrainingDays(sessions, PLAN)).toEqual(new Set(['Monday']));
  });

  it('does NOT count a rest-day recovery session (Bug 1 repro)', () => {
    // The user did a mobility flow on Tuesday (a planned rest day). The
    // session has is_recovery=true. Before the fix this inflated the
    // "X of Y" count and added a dot to the week strip.
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-01', is_recovery: false, workout_type: 'Push' }, // Mon
      { planned_date: '2026-06-02', is_recovery: true,  workout_type: 'Recovery — Mobility' }, // Tue
    ];
    const completed = computeCompletedTrainingDays(sessions, PLAN);
    expect(completed).toEqual(new Set(['Monday']));
    expect(completed.has('Tuesday')).toBe(false);
  });

  it('does NOT count a non-recovery session that happens on a plan REST day', () => {
    // User logged a workout Tuesday (which the plan calls Rest). It's not
    // a planned training day, so it shouldn't count against "X of Y" —
    // that's a missed-day question, not a planned-day completion.
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-02', is_recovery: false, workout_type: 'Push' }, // Tuesday = rest day in PLAN
    ];
    expect(computeCompletedTrainingDays(sessions, PLAN).size).toBe(0);
  });

  it('falls back to workout_type prefix when is_recovery is missing (legacy rows)', () => {
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-01', workout_type: 'Push' },
      { planned_date: '2026-06-02', workout_type: 'Recovery — Mobility' }, // legacy: no boolean column
    ];
    expect(computeCompletedTrainingDays(sessions, PLAN)).toEqual(new Set(['Monday']));
  });

  it('three completed planned days yields a set of size 3 (the "X of Y" denominator)', () => {
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-01', is_recovery: false }, // Mon
      { planned_date: '2026-06-03', is_recovery: false }, // Wed
      { planned_date: '2026-06-05', is_recovery: false }, // Fri
      { planned_date: '2026-06-02', is_recovery: true  }, // recovery on Tue — ignored
    ];
    const completed = computeCompletedTrainingDays(sessions, PLAN);
    expect(completed.size).toBe(3);
    expect(completed).toEqual(new Set(['Monday', 'Wednesday', 'Friday']));
  });

  it('handles empty inputs gracefully', () => {
    expect(computeCompletedTrainingDays([], PLAN).size).toBe(0);
    expect(computeCompletedTrainingDays([], []).size).toBe(0);
  });
});

// ── Date-anchored matching (Fix 1 — unified resolver) ─────────────────
// When the caller passes weekStartIso, completion accounting is anchored
// on each PlanDay's calendar date (preferring .date, falling back to
// weekStart + offset). This is what keeps the dashboard, calendar, and
// week-progress card agreeing for mid-week onboarders.

describe('computeCompletedTrainingDays — date-anchored (weekStartIso)', () => {
  const WEEK_START = '2026-06-01'; // Monday

  it('a session on this Monday does NOT count when the "Monday" plan entry actually means next Monday', () => {
    // Mid-week onboarder pattern. The plan is generated on Wed and the
    // "Monday" entry's .date points to next Monday — the legacy weekday-
    // name match would falsely count a same-week-Monday session.
    const PLAN_NEXT_MON: PlanDayLike[] = [
      { day: 'Wednesday', date: '2026-06-03', workoutType: 'Push' },
      { day: 'Friday',    date: '2026-06-05', workoutType: 'Pull' },
      { day: 'Monday',    date: '2026-06-08', workoutType: 'Legs' /* next Mon */ },
    ];
    const sessions: WeekSessionRow[] = [
      // User happened to bench this Monday (this Monday isn't planned).
      { planned_date: '2026-06-01', is_recovery: false, workout_type: 'Push' },
    ];
    const completed = computeCompletedTrainingDays(sessions, PLAN_NEXT_MON, WEEK_START);
    expect(completed.size).toBe(0);
  });

  it('a session on the actual planned .date counts (date-anchored, not name-anchored)', () => {
    const PLAN_DATED: PlanDayLike[] = [
      { day: 'Monday',    date: '2026-06-01', workoutType: 'Push' },
      { day: 'Wednesday', date: '2026-06-03', workoutType: 'Pull' },
    ];
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-01', is_recovery: false }, // Mon (planned)
      { planned_date: '2026-06-03', is_recovery: false }, // Wed (planned)
      { planned_date: '2026-06-02', is_recovery: false }, // Tue (not planned)
    ];
    const completed = computeCompletedTrainingDays(sessions, PLAN_DATED, WEEK_START);
    expect(completed).toEqual(new Set(['Monday', 'Wednesday']));
  });

  it('falls back to weekStart + offset when PlanDay.date is absent (legacy plans)', () => {
    // No .date — resolver reconstructs from weekStart + WEEKDAY_OFFSET.
    const PLAN_LEGACY: PlanDayLike[] = [
      { day: 'Monday',    workoutType: 'Push' },
      { day: 'Wednesday', workoutType: 'Pull' },
    ];
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-01', is_recovery: false },
      { planned_date: '2026-06-03', is_recovery: false },
    ];
    const completed = computeCompletedTrainingDays(sessions, PLAN_LEGACY, WEEK_START);
    expect(completed).toEqual(new Set(['Monday', 'Wednesday']));
  });

  it('recovery sessions are still excluded under date-anchored matching', () => {
    const PLAN_DATED: PlanDayLike[] = [
      { day: 'Monday', date: '2026-06-01', workoutType: 'Push' },
    ];
    const sessions: WeekSessionRow[] = [
      { planned_date: '2026-06-01', is_recovery: true, workout_type: 'Recovery — Mobility' },
    ];
    const completed = computeCompletedTrainingDays(sessions, PLAN_DATED, WEEK_START);
    expect(completed.size).toBe(0);
  });
});
