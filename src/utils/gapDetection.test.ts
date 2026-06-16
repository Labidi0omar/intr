// Imported from planShift (the pure module) rather than gapDetection so jest
// doesn't pull in the AsyncStorage/Supabase/RN graph.
import {
  countUnfinishedPastTrainingDays,
  daysBetweenIso,
  findEarliestUnfinishedTrainingDay,
  plannedTrainingDatesInWeek,
  resolvePlanDayForDate,
  shouldShowGapModalToday,
} from './planShift';

// Anchor week: 2026-06-01 is a Monday → weekStart.
const WEEK_START = '2026-06-01';
// 'today' choices used throughout:
const WED  = '2026-06-03'; // offset 2
const FRI  = '2026-06-05'; // offset 4
const SAT  = '2026-06-06'; // offset 5

// ── resolvePlanDayForDate ──────────────────────────────────────────────
// Single date-based resolver shared by the dashboard, the calendar, and
// the catch-up generator. Replaces the weekday-name match that drifted
// out of sync for mid-week onboarders.

describe('resolvePlanDayForDate', () => {
  it('prefers explicit .date over weekStart+offset reconstruction', () => {
    const planDays = [
      { day: 'Monday', date: '2026-06-08', workoutType: 'Push' },
    ];
    expect(resolvePlanDayForDate(planDays, WEEK_START, WEEK_START)).toBeNull();
    expect(resolvePlanDayForDate(planDays, WEEK_START, '2026-06-08')).toEqual(planDays[0]);
  });

  it('falls back to weekStart + WEEKDAY_OFFSET when .date is missing (legacy plans)', () => {
    const planDays = [
      { day: 'Monday',  workoutType: 'Push' },
      { day: 'Wednesday', workoutType: 'Pull' },
    ];
    expect(resolvePlanDayForDate(planDays, WEEK_START, WEEK_START)).toEqual(planDays[0]);
    expect(resolvePlanDayForDate(planDays, WEEK_START, WED)).toEqual(planDays[1]);
  });

  it('returns null when nothing planned covers the target date', () => {
    const planDays = [
      { day: 'Monday', date: WEEK_START, workoutType: 'Push' },
    ];
    expect(resolvePlanDayForDate(planDays, WEEK_START, '2026-06-02')).toBeNull();
  });

  it('null/empty inputs are tolerated', () => {
    expect(resolvePlanDayForDate(null, WEEK_START, WED)).toBeNull();
    expect(resolvePlanDayForDate([], WEEK_START, WED)).toBeNull();
  });

  it('unknown weekday with no .date is skipped (does not crash)', () => {
    const planDays = [
      { day: 'Funday' },
      { day: 'Wednesday', workoutType: 'Pull' },
    ];
    expect(resolvePlanDayForDate(planDays, WEEK_START, WED)).toEqual(planDays[1]);
  });
});

// ── plannedTrainingDatesInWeek ─────────────────────────────────────────
// Powers the date-anchored "is this a planned training date" check used
// by the dashboard's completion accounting.

describe('plannedTrainingDatesInWeek', () => {
  it('returns the set of ISO dates for training-typed days, .date preferred', () => {
    const planDays = [
      { day: 'Monday',    date: WEEK_START,   workoutType: 'Push' },
      { day: 'Wednesday', date: WED,          workoutType: 'Pull' },
      { day: 'Friday',    date: FRI,          workoutType: 'Legs' },
    ];
    expect(plannedTrainingDatesInWeek(planDays, WEEK_START)).toEqual(
      new Set([WEEK_START, WED, FRI]),
    );
  });

  it('excludes Rest and Recovery-prefixed workout types', () => {
    const planDays = [
      { day: 'Monday',    date: WEEK_START,   workoutType: 'Push' },
      { day: 'Tuesday',   date: '2026-06-02', workoutType: 'Rest' },
      { day: 'Wednesday', date: WED,          workoutType: 'Recovery — Mobility' },
    ];
    expect(plannedTrainingDatesInWeek(planDays, WEEK_START)).toEqual(
      new Set([WEEK_START]),
    );
  });

  it('falls back to weekStart + offset when .date is missing', () => {
    const planDays = [
      { day: 'Monday',    workoutType: 'Push' },
      { day: 'Wednesday', workoutType: 'Pull' },
    ];
    expect(plannedTrainingDatesInWeek(planDays, WEEK_START)).toEqual(
      new Set([WEEK_START, WED]),
    );
  });

  it('honors .date over day-name reconstruction (mid-week onboarder)', () => {
    const planDays = [
      { day: 'Monday', date: '2026-06-08', workoutType: 'Push' },
    ];
    const got = plannedTrainingDatesInWeek(planDays, WEEK_START);
    expect(got.has('2026-06-08')).toBe(true);
    expect(got.has(WEEK_START)).toBe(false);
  });
});

// ── daysBetweenIso ─────────────────────────────────────────────────────

describe('daysBetweenIso', () => {
  it('positive when target is later', () => {
    expect(daysBetweenIso(WEEK_START, SAT)).toBe(5);
  });
  it('zero on identical dates', () => {
    expect(daysBetweenIso(WEEK_START, WEEK_START)).toBe(0);
  });
  it('negative when target is earlier', () => {
    expect(daysBetweenIso(SAT, WEEK_START)).toBe(-5);
  });
});

// ── findEarliestUnfinishedTrainingDay ──────────────────────────────────
// Multi-row anchor scan. The earliest unfinished planned TRAINING day
// across the surveyed rows drives the GapModal trigger; the catch-up
// generator owns the actual reshuffle.

describe('findEarliestUnfinishedTrainingDay', () => {
  const NEXT_WEEK_START = '2026-06-08';
  const NEXT_SAT = '2026-06-13';

  it('CROSS-ROW: missed leg day in a PRIOR week surfaces as the anchor', () => {
    const lastWeek = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START,   workoutType: 'Push' },
        { day: 'Wednesday', date: WED,          workoutType: 'Pull' },
        { day: 'Friday',    date: FRI,          workoutType: 'Legs' },
      ],
    };
    const thisWeek = {
      weekStart: NEXT_WEEK_START,
      planDays: [
        { day: 'Monday',    date: NEXT_WEEK_START, workoutType: 'Push' },
        { day: 'Wednesday', date: '2026-06-10',    workoutType: 'Pull' },
        { day: 'Friday',    date: '2026-06-12',    workoutType: 'Legs' },
      ],
    };
    const completed = new Set<string>([WEEK_START, WED]);
    const anchor = findEarliestUnfinishedTrainingDay(
      [lastWeek, thisWeek],
      NEXT_SAT,
      completed,
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.earliestDate).toBe(FRI);
    expect(anchor!.rowWeekStart).toBe(WEEK_START);
    expect(anchor!.offsetDays).toBe(8);
  });

  it('returns null when every past planned training day is completed', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START, workoutType: 'Push' },
        { day: 'Wednesday', date: WED,        workoutType: 'Pull' },
        { day: 'Friday',    date: FRI,        workoutType: 'Legs' },
      ],
    };
    const completed = new Set<string>([WEEK_START, WED, FRI]);
    expect(findEarliestUnfinishedTrainingDay([row], SAT, completed)).toBeNull();
  });

  it('Rest and Recovery days never anchor (even if uncompleted)', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START,   workoutType: 'Push' },
        { day: 'Tuesday',   date: '2026-06-02', workoutType: 'Rest' },
        { day: 'Wednesday', date: WED,          workoutType: 'Recovery — Mobility' },
      ],
    };
    const completed = new Set<string>([WEEK_START]);
    expect(findEarliestUnfinishedTrainingDay([row], SAT, completed)).toBeNull();
  });

  it('today-or-future planned days are never anchors', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Friday',   date: FRI, workoutType: 'Push' },
        { day: 'Saturday', date: SAT, workoutType: 'Pull' },
      ],
    };
    expect(findEarliestUnfinishedTrainingDay([row], FRI, new Set())).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(findEarliestUnfinishedTrainingDay([], SAT, new Set())).toBeNull();
    expect(findEarliestUnfinishedTrainingDay(
      [{ weekStart: WEEK_START, planDays: [] }],
      SAT,
      new Set(),
    )).toBeNull();
  });

  it('falls back to weekStart + WEEKDAY_OFFSET when PlanDay.date is missing (legacy rows)', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    workoutType: 'Push' },
        { day: 'Wednesday', workoutType: 'Pull' },
      ],
    };
    const anchor = findEarliestUnfinishedTrainingDay([row], SAT, new Set());
    expect(anchor).not.toBeNull();
    expect(anchor!.earliestDate).toBe(WEEK_START);
    expect(anchor!.offsetDays).toBe(5);
  });
});

// ── countUnfinishedPastTrainingDays ────────────────────────────────────
// Drives the catch-up generator's backlog N.

describe('countUnfinishedPastTrainingDays', () => {
  it('counts every past planned training day not in completedDates', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START, workoutType: 'Push' /* done */ },
        { day: 'Wednesday', date: WED,        workoutType: 'Pull' /* MISSED */ },
        { day: 'Friday',    date: FRI,        workoutType: 'Legs' /* MISSED */ },
      ],
    };
    const completed = new Set<string>([WEEK_START]);
    expect(countUnfinishedPastTrainingDays([row], SAT, completed)).toBe(2);
  });

  it('does not count today-or-future planned days', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',  date: WEEK_START, workoutType: 'Push' /* done */ },
        { day: 'Saturday', date: SAT,        workoutType: 'Pull' /* today */ },
      ],
    };
    expect(countUnfinishedPastTrainingDays([row], SAT, new Set([WEEK_START]))).toBe(0);
  });

  it('skips Rest and Recovery-prefixed days', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Tuesday',   date: '2026-06-02', workoutType: 'Rest' },
        { day: 'Wednesday', date: WED,          workoutType: 'Recovery — Mobility' },
        { day: 'Friday',    date: FRI,          workoutType: 'Legs' /* MISSED */ },
      ],
    };
    expect(countUnfinishedPastTrainingDays([row], SAT, new Set())).toBe(1);
  });

  it('counts across multiple rows (cross-week backlog)', () => {
    const lastWeek = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START, workoutType: 'Push' /* MISSED */ },
        { day: 'Wednesday', date: WED,        workoutType: 'Pull' /* MISSED */ },
      ],
    };
    const thisWeek = {
      weekStart: '2026-06-08',
      planDays: [
        { day: 'Monday', date: '2026-06-08', workoutType: 'Push' /* MISSED */ },
      ],
    };
    expect(countUnfinishedPastTrainingDays([lastWeek, thisWeek], '2026-06-13', new Set())).toBe(3);
  });

  // ── Watermark (Bug 1 fix) ─────────────────────────────────────────
  it('WATERMARK: planned dates on-or-before resolvedThroughIso are not counted', () => {
    // The user pressed resume/skip yesterday, setting watermark = SAT
    // (2026-06-06). On the next focus, the past stranded misses still
    // exist in the DB but must NOT re-count. The watermark gates them.
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START, workoutType: 'Push' /* MISSED, ≤ watermark */ },
        { day: 'Wednesday', date: WED,        workoutType: 'Pull' /* MISSED, ≤ watermark */ },
        { day: 'Friday',    date: FRI,        workoutType: 'Legs' /* MISSED, ≤ watermark */ },
      ],
    };
    // today is the day AFTER watermark.
    const TODAY_AFTER = '2026-06-07';
    expect(
      countUnfinishedPastTrainingDays([row], TODAY_AFTER, new Set(), SAT /* watermark */),
    ).toBe(0);
  });

  it('WATERMARK: a NEW miss on a date AFTER the watermark still counts', () => {
    // User resolved through SAT, then missed today's planned session.
    // Today (FRI in this scenario) is past the watermark? No — let's
    // construct: watermark = WEEK_START, today = FRI, miss = WED.
    // WED > WEEK_START → still counts.
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START, workoutType: 'Push' /* ≤ watermark, ignored */ },
        { day: 'Wednesday', date: WED,        workoutType: 'Pull' /* > watermark, counts */ },
      ],
    };
    expect(
      countUnfinishedPastTrainingDays([row], FRI, new Set(), WEEK_START),
    ).toBe(1);
  });

  it('WATERMARK: null / undefined watermark is the no-watermark baseline', () => {
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday', date: WEEK_START, workoutType: 'Push' /* MISSED */ },
      ],
    };
    expect(countUnfinishedPastTrainingDays([row], SAT, new Set(), null)).toBe(1);
    expect(countUnfinishedPastTrainingDays([row], SAT, new Set(), undefined)).toBe(1);
  });

  it('IDEMPOTENT: simulating a resume then a re-scan past the watermark yields 0', () => {
    // First scan (no watermark) sees 2 misses. After the user presses
    // resume, the handler writes watermark = today's ISO. The next
    // scan must report 0 even though the past-week row is untouched.
    const row = {
      weekStart: WEEK_START,
      planDays: [
        { day: 'Monday',    date: WEEK_START, workoutType: 'Push' /* MISSED */ },
        { day: 'Wednesday', date: WED,        workoutType: 'Pull' /* MISSED */ },
      ],
    };
    const todayIso = FRI;
    const before = countUnfinishedPastTrainingDays([row], todayIso, new Set());
    expect(before).toBe(2);
    const after = countUnfinishedPastTrainingDays([row], todayIso, new Set(), todayIso);
    expect(after).toBe(0);
  });
});

// ── Real-account repro: backlog over-count ─────────────────────────────
// Account intr@gmail.com, 2026-06-11. PPL / 3-day (Mon/Wed/Fri), 10
// completed sessions in a clean Push→Pull→Legs cycle, last completed =
// Push on Mon Jun 8. Today = Thu Jun 11. The ONLY missed day is Pull on
// Wed Jun 10 — Legs Fri Jun 12 is in the future. The production bug
// computed backlog 3 because the completions window (today-21) was
// narrower than the plan survey window (today-27): the May 18 and May 20
// completions fell outside it and their planned days looked "missed".
// With the full completions set (windows now aligned in home.tsx), the
// count must be exactly 1.

describe('REPRO intr@gmail.com — backlog counts only truly-missed past days', () => {
  const TODAY = '2026-06-11'; // Thursday
  // Four stored weeks, Monday-anchored, Mon/Wed/Fri PPL.
  const week = (monday: string, d2: string, d3: string) => ({
    weekStart: monday,
    planDays: [
      { day: 'Monday',    date: monday, workoutType: 'Push' },
      { day: 'Wednesday', date: d2,     workoutType: 'Pull' },
      { day: 'Friday',    date: d3,     workoutType: 'Legs' },
    ],
  });
  const rows = [
    week('2026-05-18', '2026-05-20', '2026-05-22'),
    week('2026-05-25', '2026-05-27', '2026-05-29'),
    week('2026-06-01', '2026-06-03', '2026-06-05'),
    week('2026-06-08', '2026-06-10', '2026-06-12'),
  ];
  // All 10 completed sessions — the clean P→P→L cycle ending Push Jun 8.
  const completed = new Set<string>([
    '2026-05-18', '2026-05-20', '2026-05-22',
    '2026-05-25', '2026-05-27', '2026-05-29',
    '2026-06-01', '2026-06-03', '2026-06-05',
    '2026-06-08',
  ]);

  it('backlog = 1: only Pull Wed Jun 10 is past-and-unfinished', () => {
    expect(countUnfinishedPastTrainingDays(rows, TODAY, completed)).toBe(1);
  });

  it('the anchor is Pull Jun 10, one day back', () => {
    const anchor = findEarliestUnfinishedTrainingDay(rows, TODAY, completed);
    expect(anchor).not.toBeNull();
    expect(anchor!.earliestDate).toBe('2026-06-10');
    expect(anchor!.offsetDays).toBe(1);
  });

  it('Legs Fri Jun 12 (future) never counts, even uncompleted', () => {
    // Drop Jun 10 from the picture: complete it. Now nothing is missed —
    // the future Legs day alone must produce backlog 0.
    const withPullDone = new Set(completed);
    withPullDone.add('2026-06-10');
    expect(countUnfinishedPastTrainingDays(rows, TODAY, withPullDone)).toBe(0);
    expect(findEarliestUnfinishedTrainingDay(rows, TODAY, withPullDone)).toBeNull();
  });

  it('DEDUPE: the same missed date in two overlapping (corrupted) rows counts once', () => {
    // Corruption artifact: two rows whose 7-day windows overlap both carry
    // a planned day on Jun 10. One date missed = one session owed.
    const corrupted = [
      rows[3],
      {
        weekStart: '2026-06-06',
        planDays: [{ day: 'Wednesday', date: '2026-06-10', workoutType: 'Legs' }],
      },
    ];
    expect(countUnfinishedPastTrainingDays(corrupted, TODAY, completed)).toBe(1);
  });
});

// ── shouldShowGapModalToday ────────────────────────────────────────────
// Day-level gate shared by BOTH GapModal trigger paths in
// fetchDashboardData (the anchor scan AND the legacy detectReturnGap
// fallback). ackGap writes only the gap:resolvedThrough watermark, so
// this gate is what makes one press silence the modal for the day.

describe('shouldShowGapModalToday', () => {
  const TODAY = '2026-06-11';

  it('allows the modal when no watermark exists (first encounter)', () => {
    expect(shouldShowGapModalToday(TODAY, null)).toBe(true);
    expect(shouldShowGapModalToday(TODAY, undefined)).toBe(true);
  });

  it('suppresses the modal when the watermark equals today (ackGap pressed today)', () => {
    expect(shouldShowGapModalToday(TODAY, TODAY)).toBe(false);
  });

  it('suppresses the modal when the watermark is after today (clock skew safety)', () => {
    expect(shouldShowGapModalToday(TODAY, '2026-06-12')).toBe(false);
  });

  it('allows the modal again on a later day (watermark from yesterday)', () => {
    expect(shouldShowGapModalToday(TODAY, '2026-06-10')).toBe(true);
  });

  // ── Loop reproduction (fallback-only account) ──────────────────────
  // Regression for the infinite "you missed days" loop: an account whose
  // gap is detected ONLY via the detectReturnGap fallback — no unfinished
  // planned training days inside the survey window (e.g. long-dormant,
  // all misses older than the surveyed rows), but detectReturnGap >= 3.
  // ackGap writes the watermark but NOT the legacy intr:gapAck key, so
  // gating the fallback on the ack key alone re-fires the modal on every
  // subsequent focus. The fallback must honor the watermark.
  it('LOOP REPRO: fallback-only gap must not re-show after ackGap sets the watermark', () => {
    // Survey window rows: none with unfinished past training days
    // (empty — the dormant account's misses fall outside the window).
    const surveyRows: Array<{ weekStart: string; planDays: any[] }> = [];
    const completedDates = new Set<string>();
    const detectedReturnGap = 14; // legacy fallback signal, >= 3

    // Mirrors fetchDashboardData's decision: day-level watermark gate
    // wrapping both paths, anchor scan first, fallback second.
    const wouldShowModal = (watermark: string | null): boolean => {
      if (!shouldShowGapModalToday(TODAY, watermark)) return false;
      const anchor = findEarliestUnfinishedTrainingDay(
        surveyRows, TODAY, completedDates, watermark,
      );
      if (anchor) return true;
      return detectedReturnGap >= 3;
    };

    // Focus 1: no watermark yet — the fallback fires the modal.
    expect(wouldShowModal(null)).toBe(true);

    // User presses resume/skip: ackGap sets gap:resolvedThrough = today
    // (and nothing else — no intr:gapAck key).
    const watermarkAfterAck = TODAY;

    // Focus 2 (same day): the modal must NOT re-show. Before the fix the
    // fallback ignored the watermark and this evaluated to true forever.
    expect(wouldShowModal(watermarkAfterAck)).toBe(false);
  });
});
