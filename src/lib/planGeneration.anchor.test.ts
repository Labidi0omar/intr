// Regression test for the plan date-anchor mismatch.
//
// Before the fix: generatePlan placed training days at offsets from TODAY
// (e.g., onboarding on a Friday → days on Fri/Sun/Tue), but the row was
// stored with week_start = MONDAY (currentWeekStart). Readers checked the
// window [week_start, week_start+6] anchored on Monday and rejected the
// Tue *after* the following Monday — actually worse: a Friday-onboard means
// trainingDays=3 lands on Fri (offset 0), Sun (+2), Tue (+4). The Monday
// anchor's window was [prevMon, prevMon+6=Sun] — so Tue spilled out and the
// scheduled Friday workout (today) was *before* the stored Monday anchor in
// the legacy "week_start = nextMonday" variant. Either way: today's workout
// disappeared.
//
// After the fix: week_start = generation day (today). Every generated day
// lies within [today, today+6] by construction.

/// <reference types="node" />
import { generatePlan } from './planGeneration';

declare const global: any;

// Pin "now" to a Friday so pickDefaultDayOffsets(3) → [0,2,4] resolves to
// Fri/Sun/Tue, the bug's reproduction case.
const FRIDAY = new Date(2026, 4, 29); // 2026-05-29 — Friday (month is 0-indexed)

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(weekStart: string, n: number): string {
  const p = weekStart.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return isoOf(d);
}

// Old (buggy) Monday-of-this-week anchor.
function mondayOf(d: Date): string {
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMonday);
  return isoOf(m);
}

describe('plan date-anchor (Friday-onboard regression)', () => {
  let realDate: DateConstructor;

  beforeAll(() => {
    realDate = global.Date;
    class MockDate extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(FRIDAY.getTime());
          return;
        }
        // @ts-ignore
        super(...args);
      }
      static now() { return FRIDAY.getTime(); }
    }
    // @ts-ignore
    global.Date = MockDate;
  });

  afterAll(() => {
    global.Date = realDate;
  });

  it('all training days fall within [week_start, week_start+6] when anchored on today', () => {
    const plan = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 3,
      location: 'gym',
    });

    const weekStart = isoOf(FRIDAY);            // new anchor: today (Friday)
    const weekEnd = addDays(weekStart, 6);

    expect(plan.length).toBeGreaterThan(0);

    for (const d of plan) {
      expect(d.date).toBeDefined();
      expect(d.date! >= weekStart).toBe(true);   // (c) none before week_start
      expect(d.date! <= weekEnd).toBe(true);     // (b) within +6 window
    }

    // (a) today (Friday) resolves to a workout.
    const todayPlan = plan.find(d => d.date === weekStart);
    expect(todayPlan).toBeDefined();
    expect(todayPlan!.exercises.length).toBeGreaterThan(0);
  });

  it('would have failed against the OLD Monday anchor: some generated days fall outside [monday, monday+6]', () => {
    const plan = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 3,
      location: 'gym',
    });

    const buggyWeekStart = mondayOf(FRIDAY);     // legacy: this week's Monday
    const buggyWeekEnd = addDays(buggyWeekStart, 6);

    // Friday + offset 4 → Tuesday of NEXT week, which is past
    // (Mon..Sun = buggyWeekEnd). Confirms the bug the new anchor fixes.
    const outOfWindow = plan.filter(d => !(d.date! >= buggyWeekStart && d.date! <= buggyWeekEnd));
    expect(outOfWindow.length).toBeGreaterThan(0);
  });
});
