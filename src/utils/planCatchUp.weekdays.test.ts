// Integration tests for the user-selected weekday picker. These pin the
// invariants the heal path depends on:
//
//   1. Sessions land ONLY on the user's chosen calendar weekdays.
//   2. deriveCanonicalWeek + a per-week generatePlan call agree on
//      placement when both consume the same training_weekdays → offsets.
//      Without this the active-week self-heal would rewrite the row on
//      every app focus (the #1 risk the spec calls out).
//   3. Null training_weekdays falls back to pickDefaultDayOffsets so
//      legacy / 1/2/7-day users don't regress.

import { generatePlan } from '../lib/planGeneration';
import { deriveCanonicalWeek } from './planCatchUp';
import { weekdaysToOffsets } from './trainingWeekdays';

// 2026-06-14 is a Sunday — picked so Mon=offset 1, Wed=offset 3, Fri=offset 5.
const SUNDAY_WEEK_START = '2026-06-14';
// 2026-06-17 is a Wednesday — used to confirm the offset formula handles
// non-Sunday week anchors (which planSync passes when the existing row's
// week_start happens to fall on a Wed).
const WEDNESDAY_WEEK_START = '2026-06-17';

const BASE = {
  fitnessLevel: 'intermediate' as const,
  trainingDays: 3,
  location: 'gym' as const,
  split: 'ppl' as const,
  blockIndex: 0,
  blockWeek: 1,
  completedBeforeWeek: 0,
};

describe('weekday picker — generatePlan placement', () => {
  it('Mon/Wed/Fri picks place sessions only on Mon, Wed, Fri', () => {
    const offsets = weekdaysToOffsets([1, 3, 5], SUNDAY_WEEK_START)!;
    const plan = generatePlan({
      ...BASE,
      weeksAhead: 2,
      startDate: SUNDAY_WEEK_START,
      selectedDayOffsets: offsets,
    });

    expect(plan).toHaveLength(6); // 3 days × 2 weeks
    for (const d of plan) {
      // Generator stamps PlanDay.day with the long weekday name from the
      // date. Mon/Wed/Fri is what we want — nothing else may slip in.
      expect(['Monday', 'Wednesday', 'Friday']).toContain(d.day);
    }
  });

  it('Mon/Wed/Fri anchored to a Wednesday week start still lands on Mon/Wed/Fri', () => {
    // From a Wednesday start, the conversion yields [0, 2, 5] — the
    // generator stamps those onto Wed/Fri/Mon by date math. Coverage is
    // identical even though offsets look different.
    const offsets = weekdaysToOffsets([1, 3, 5], WEDNESDAY_WEEK_START)!;
    const plan = generatePlan({
      ...BASE,
      weeksAhead: 1,
      startDate: WEDNESDAY_WEEK_START,
      selectedDayOffsets: offsets,
    });

    expect(plan).toHaveLength(3);
    for (const d of plan) {
      expect(['Monday', 'Wednesday', 'Friday']).toContain(d.day);
    }
  });
});

describe('weekday picker — heal idempotency', () => {
  // The active-week self-heal compares the stored row against
  // deriveCanonicalWeek. If the canonical and the per-week generation
  // disagree on placement, every app focus rewrites the row. The
  // production planSync.ts feeds the SAME training_weekdays into both
  // paths via the SAME weekdaysToOffsets helper — these tests pin that
  // contract at the lib level.

  it('deriveCanonicalWeek with weekdays-derived offsets agrees with generatePlan(weeksAhead=1)', () => {
    const weekdays = [1, 3, 5]; // Mon/Wed/Fri
    const offsets = weekdaysToOffsets(weekdays, SUNDAY_WEEK_START)!;

    const canonical = deriveCanonicalWeek({
      weekStartIso: SUNDAY_WEEK_START,
      completedBeforeWeek: 0,
      trainingDays: 3,
      fitnessLevel: 'intermediate',
      location: 'gym',
      split: 'ppl',
      blockIndex: 0,
      blockWeek: 1,
      selectedDayOffsets: offsets,
    });

    const direct = generatePlan({
      ...BASE,
      weeksAhead: 1,
      startDate: SUNDAY_WEEK_START,
      selectedDayOffsets: offsets,
    });

    // (date, day, workoutType) are the heal's comparison surface. Pin
    // the full triple — drift in any one would let the heal rewrite the
    // stored row on next focus.
    const project = (p: typeof direct) => p.map(d => ({ date: d.date, day: d.day, workoutType: d.workoutType }));
    expect(project(canonical)).toEqual(project(direct));
  });

  it('re-running deriveCanonicalWeek twice yields identical placement', () => {
    const offsets = weekdaysToOffsets([1, 3, 5], SUNDAY_WEEK_START)!;
    const args = {
      weekStartIso: SUNDAY_WEEK_START,
      completedBeforeWeek: 7,            // mid-mesocycle resume
      trainingDays: 3,
      fitnessLevel: 'intermediate' as const,
      location: 'gym' as const,
      split: 'bro_split' as const,        // exercises the new rolling phase too
      blockIndex: 1,
      blockWeek: 2,
      selectedDayOffsets: offsets,
    };
    const a = deriveCanonicalWeek(args);
    const b = deriveCanonicalWeek(args);
    expect(b).toEqual(a);
  });

  it('null weekdays → deriveCanonicalWeek falls back to pickDefaultDayOffsets (no regression)', () => {
    // Omit selectedDayOffsets exactly as production planSync does when the
    // user has no training_weekdays pick (legacy account).
    const canonical = deriveCanonicalWeek({
      weekStartIso: SUNDAY_WEEK_START,
      completedBeforeWeek: 0,
      trainingDays: 3,
      fitnessLevel: 'intermediate',
      location: 'gym',
      split: 'ppl',
      blockIndex: 0,
      blockWeek: 1,
    });
    // pickDefaultDayOffsets(3) = [0, 2, 4]. From a Sunday week_start that
    // lands on Sun/Tue/Thu — the historical placement we must preserve.
    expect(canonical.map(d => d.day)).toEqual(['Sunday', 'Tuesday', 'Thursday']);
  });
});
