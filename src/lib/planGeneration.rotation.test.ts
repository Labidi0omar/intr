// Regression tests for the 'fixed' rotation (bro_split).
// History of this bug:
//   - Originally globalI was a continuous multi-week counter, so once
//     globalI >= dayTypes.length (5) every training day fell into dropOrder
//     and only arms/shoulders were emitted forever (the "collapse").
//   - The first fix wrapped dayTypes by globalI % dayTypes.length. That
//     stopped the collapse but DRIFTED the weekly phase: with 6 training
//     days, globalI advanced 6/week, so each week started one slot later
//     (week2=back, week3=shoulders...) and the calendar spliced the drifting
//     weeks into a chest-less, arms-heavy mess.
//   - Current behavior: a 'fixed' split is a STABLE WEEKLY TEMPLATE keyed on
//     the in-week index, so every week is the identical assignment. dropOrder
//     supplies the extra day(s) only when trainingDays > dayTypes.length.

/// <reference types="node" />
import { generatePlan, nextRotationPhase } from './planGeneration';

const MONDAY = new Date(2026, 5, 1); // 2026-06-01 (Mon) — month is 0-indexed

describe('bro_split multi-week rotation', () => {
  let realDate: DateConstructor;

  beforeAll(() => {
    realDate = global.Date;
    class MockDate extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) { super(MONDAY.getTime()); return; }
        // @ts-ignore
        super(...args);
      }
      static now() { return MONDAY.getTime(); }
    }
    // @ts-ignore
    global.Date = MockDate;
  });

  afterAll(() => { global.Date = realDate; });

  it('5-day bro split with default phase yields the canonical chest→legs template every week', () => {
    // trainingDays === dayTypes.length (5 === 5) so the per-week phase
    // advance (dayIndexOffset + week*trainingDays) wraps cleanly back to 0
    // every week. The user sees an identical chest→legs schedule. With a
    // non-zero dayIndexOffset (mid-mesocycle resume), the same math rolls
    // the start; see the bro_split resume tests in planCatchUp.test.ts.
    const plan = generatePlan({
      fitnessLevel: 'intermediate',
      trainingDays: 5,
      location: 'gym',
      weeksAhead: 4,
      selectedDayOffsets: [0, 1, 2, 3, 4],
    });

    expect(plan.length).toBe(20);

    const template = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs'];
    for (let w = 0; w < 4; w++) {
      const week = plan.slice(w * 5, w * 5 + 5).map(d => d.workoutType);
      expect(week).toEqual(template);
    }
  });

  it('6-day bro split: every week still covers all 5 muscle groups (rolling template + dropOrder)', () => {
    // As of CURRENT_PLAN_VERSION 6, the fixed rotation advances its phase
    // by trainingDays per week. trainingDays=6 (>= dayTypes.length=5)
    // drifts +1 per week, so the weekly assignment is no longer a fixed
    // chest→legs+arms template. The user contract that still holds: every
    // week's six sessions cover all five muscle groups. Within-week
    // ordering rotates, but coverage doesn't regress.
    const plan = generatePlan({
      fitnessLevel: 'intermediate',
      trainingDays: 6,
      location: 'gym',
      weeksAhead: 3,
      selectedDayOffsets: [0, 1, 2, 3, 4, 5],
    });

    expect(plan.length).toBe(18);

    const expectedGroups = new Set(['Chest', 'Back', 'Shoulders', 'Arms', 'Legs']);
    for (let w = 0; w < 3; w++) {
      const week = plan.slice(w * 6, w * 6 + 6).map(d => d.workoutType);
      expect(new Set(week)).toEqual(expectedGroups);
    }
  });

  it('upper_lower keeps alternating across multi-week generation', () => {
    const plan = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 4,
      location: 'gym',
      weeksAhead: 3,
      selectedDayOffsets: [0, 2, 4, 6],
    });
    // 4 days * 3 weeks = 12 entries, strictly alternating upper/lower.
    expect(plan.length).toBe(12);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].workoutType).not.toBe(plan[i - 1].workoutType);
    }
  });

  it('ppl keeps cycling push→pull→legs across multi-week generation', () => {
    const plan = generatePlan({
      fitnessLevel: 'beginner',
      trainingDays: 3,
      location: 'gym',
      weeksAhead: 3,
      selectedDayOffsets: [0, 2, 4],
    });
    const seq = plan.map(d => d.workoutType);
    expect(seq).toEqual([
      'Push', 'Pull', 'Legs',
      'Push', 'Pull', 'Legs',
      'Push', 'Pull', 'Legs',
    ]);
  });

  // ── BUG FIX (v6): bro_split with trainingDays < dayTypes.length used to
  // restart at chest every week, structurally never reaching arms/legs.
  // The rolling phase via dayIndexOffset + week*trainingDays fixes it.

  it('3-day bro_split rotates across weeks so arms and legs are reached', () => {
    const plan = generatePlan({
      fitnessLevel: 'intermediate',
      trainingDays: 3,
      location: 'gym',
      split: 'bro_split',
      weeksAhead: 3,
      selectedDayOffsets: [0, 2, 4],
    });

    // Three weeks × 3 days = 9 sessions.
    expect(plan.length).toBe(9);

    // All 5 muscle groups are reached within 3 weeks (in fact within 2 —
    // 5/3 ≈ 1.7 weeks). Before the fix this set was {Chest, Back, Shoulders}.
    const touched = new Set(plan.map(d => d.workoutType));
    for (const t of ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs']) {
      expect(touched.has(t)).toBe(true);
    }

    // Each week's three slots are three distinct muscle groups — no
    // intra-week repetition.
    for (let w = 0; w < 3; w++) {
      const wk = plan.slice(w * 3, w * 3 + 3).map(d => d.workoutType);
      expect(new Set(wk).size).toBe(3);
    }
  });

  it('4-day bro_split rotates across weeks so arms and legs are reached', () => {
    const plan = generatePlan({
      fitnessLevel: 'intermediate',
      trainingDays: 4,
      location: 'gym',
      split: 'bro_split',
      weeksAhead: 3,
      selectedDayOffsets: [0, 2, 4, 6],
    });

    const touched = new Set(plan.map(d => d.workoutType));
    for (const t of ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs']) {
      expect(touched.has(t)).toBe(true);
    }
  });

  it('3-day bro_split: single multi-week call agrees with three single-week calls (heal/catch-up idempotency)', () => {
    // The active-week self-heal (deriveCanonicalWeek) calls generatePlan
    // with weeksAhead=1 and dayIndexOffset=completedBeforeWeek. The
    // production planSync.ensureCurrentWeekPlan loop does the same per
    // week with dayIndexOffset = completedBeforeWeek + i*trainingDays.
    // If a single multi-week generation didn't agree with N consecutive
    // single-week generations, the heal would fight whatever the
    // multi-week catch-up wrote and the user would see plan churn on
    // every focus. Pin the invariant.
    const base = {
      fitnessLevel: 'intermediate' as const,
      trainingDays: 3,
      location: 'gym' as const,
      split: 'bro_split' as const,
      selectedDayOffsets: [0, 2, 4],
    };

    const bulk = generatePlan({ ...base, weeksAhead: 3 });
    const perWeek: typeof bulk = [];
    for (let i = 0; i < 3; i++) {
      perWeek.push(
        ...generatePlan({
          ...base,
          weeksAhead: 1,
          dayIndexOffset: i * base.trainingDays,
          startDate: bulk[i * base.trainingDays].date,
        }),
      );
    }

    expect(perWeek.map(d => d.workoutType)).toEqual(
      bulk.map(d => d.workoutType),
    );
  });
});

// ── nextRotationPhase — deriving resume position from the last completed
// session's workout_type, not a lifetime count ─────────────────────────
//
// Bug: ackGap('resume') used to pass a raw lifetime completed-session
// COUNT straight through as dayIndexOffset. That count is a fragile proxy
// for rotation position — it lands on dayTypes[0] (chest, for bro_split)
// whenever it happens to be a multiple of dayTypes.length or reads 0, and
// it drifts on any split change, ad-hoc session, or un-counted completion.
// nextRotationPhase reads the ACTUAL last completed workout_type (as
// stored on workout_sessions — the capitalized DAY_TYPE_LABELS value, e.g.
// "Legs") and maps it to lastTypeIndex + 1, which is exact regardless of
// how the count got there.

describe('nextRotationPhase', () => {
  it('bro_split: every type maps to the next type in the rotation (arms → legs)', () => {
    // dayTypes = ['chest', 'back', 'shoulders', 'arms', 'legs'].
    const cases: Array<[string, number]> = [
      ['Chest', 1],
      ['Back', 2],
      ['Shoulders', 3],
      ['Arms', 4],
      ['Legs', 5],
    ];
    for (const [lastWorkoutType, expectedPhase] of cases) {
      const phase = nextRotationPhase({ split: 'bro_split', trainingDays: 5, lastWorkoutType });
      expect(phase).toBe(expectedPhase);
    }
  });

  it('bro_split: Arms → phase 4 → dayTypes[4 % 5] = Legs, not a chest restart', () => {
    const phase = nextRotationPhase({ split: 'bro_split', trainingDays: 5, lastWorkoutType: 'Arms' });
    const dayTypes = ['chest', 'back', 'shoulders', 'arms', 'legs'];
    expect(dayTypes[phase! % dayTypes.length]).toBe('legs');
  });

  it('bro_split: Legs (the last type) wraps back to Chest, not a null/overflow', () => {
    const phase = nextRotationPhase({ split: 'bro_split', trainingDays: 5, lastWorkoutType: 'Legs' });
    const dayTypes = ['chest', 'back', 'shoulders', 'arms', 'legs'];
    expect(dayTypes[phase! % dayTypes.length]).toBe('chest');
  });

  it('PPL: preserves "missed legs → next is push" — Legs maps to the push phase', () => {
    const phase = nextRotationPhase({ split: 'ppl', trainingDays: 3, lastWorkoutType: 'Legs' });
    const dayTypes = ['push', 'pull', 'legs'];
    expect(dayTypes[phase! % dayTypes.length]).toBe('push');
  });

  it('upper_lower: Lower maps to the upper phase (alternation continues)', () => {
    const phase = nextRotationPhase({ split: 'upper_lower', trainingDays: 2, lastWorkoutType: 'Lower' });
    const dayTypes = ['upper', 'lower'];
    expect(dayTypes[phase! % dayTypes.length]).toBe('upper');
  });

  it('returns null when there is no last completed session (true cold start)', () => {
    expect(nextRotationPhase({ split: 'bro_split', trainingDays: 5, lastWorkoutType: null })).toBeNull();
    expect(nextRotationPhase({ split: 'bro_split', trainingDays: 5, lastWorkoutType: undefined })).toBeNull();
  });

  it('returns null when the type does not belong to the resolved split (split change / ad-hoc)', () => {
    // "Upper" isn't a bro_split dayType — e.g. the user switched splits
    // since that session. Callers fall back to the count-based phase.
    expect(nextRotationPhase({ split: 'bro_split', trainingDays: 5, lastWorkoutType: 'Upper' })).toBeNull();
  });

  it('falls back to splitForDays when split is omitted, same as resolveSplit', () => {
    // trainingDays=3 with no split → ppl. Legs → push phase.
    const phase = nextRotationPhase({ trainingDays: 3, lastWorkoutType: 'Legs' });
    const dayTypes = ['push', 'pull', 'legs'];
    expect(dayTypes[phase! % dayTypes.length]).toBe('push');
  });
});
