/// <reference types="node" />
// Tests for buildCatchUpRows — the GapModal "continue where I left off"
// catch-up pack builder. Pure module; no mocks beyond what generatePlan
// already requires (none — generatePlan is itself pure).
//
// What we guard:
//   - First N sessions land on consecutive calendar days starting today
//     (no rest between).
//   - Order of dayTypes comes from generatePlan — never reordered.
//   - For PPL: the rotation continues at the user's true next type
//     given mesocyclePosition (legs → push, not legs → chest).
//   - Cadence resumes after the backlog (normal weekday spread).
//   - Backlog 0 ⇒ no catch-up sessions (just a normal-cadence horizon).
//   - Idempotent: re-running with backlog 0 produces a generator-only
//     result, no shifts compounding.
//   - Cross-week packing: an N that exceeds 7 still lands consecutively.

import {
  buildCatchUpRows,
  deriveCanonicalWeek,
  healCurrentWeekRow,
  weekRowMatchesCanonical,
} from './planCatchUp';
import { nextRotationPhase } from '../lib/planGeneration';

const baseArgs = {
  todayIso: '2026-06-06', // Saturday
  trainingDays: 3,
  fitnessLevel: 'beginner' as const,
  location: 'gym' as const,
  planHistory: [],
  blockIndex: 0,
  blockWeek: 1,
  horizonWeeks: 4,
};

/** YYYY-MM-DD for (anchor + n days), local time. Mirrors the helper
 *  used inside the SUT. */
function addDays(anchor: string, n: number): string {
  const p = anchor.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function flatten(rows: { planDays: Array<{ date?: string; workoutType: string }> }[]): Array<{ date: string; workoutType: string }> {
  const out: Array<{ date: string; workoutType: string }> = [];
  for (const row of rows) {
    for (const d of row.planDays) {
      if (d.date) out.push({ date: d.date, workoutType: d.workoutType });
    }
  }
  out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return out;
}

describe('buildCatchUpRows — back-to-back catch-up segment', () => {
  it('packs the first N sessions on consecutive calendar days starting today', () => {
    // PPL, user is at mesocycle position 0 (just starting). Backlog 3:
    // every session of the first PPL block was missed.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 3,
      mesocyclePosition: 0,
    });
    const all = flatten(rows);
    // First three sessions: today, today+1, today+2 — no rest between.
    expect(all[0].date).toBe(baseArgs.todayIso);
    expect(all[1].date).toBe(addDays(baseArgs.todayIso, 1));
    expect(all[2].date).toBe(addDays(baseArgs.todayIso, 2));
  });

  it('preserves the generator split order across the catch-up segment (PPL)', () => {
    // PPL canonical sequence with mesocyclePosition 0 is push → pull → legs.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 3,
      mesocyclePosition: 0,
    });
    const all = flatten(rows);
    expect(all.slice(0, 3).map(s => s.workoutType)).toEqual(['Push', 'Pull', 'Legs']);
  });

  it('REGRESSION: missed legs → next type is correct cycle continuation, not chest restart', () => {
    // Bug the catch-up flow exists to fix. User completed push + pull this
    // week (mesocyclePosition 2) and missed the legs day. Next session
    // due is legs (cycleIndex 2 = legs). Then push, pull, … not chest.
    // The legacy rigid-shift implementation produced `legs → chest` for
    // bro_split fall-through bugs; this assertion locks the PPL fix in.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 2,
      mesocyclePosition: 2,
    });
    const all = flatten(rows);
    expect(all[0].workoutType).toBe('Legs');
    expect(all[1].workoutType).toBe('Push');
    // Catch-up days are back-to-back.
    expect(all[0].date).toBe(baseArgs.todayIso);
    expect(all[1].date).toBe(addDays(baseArgs.todayIso, 1));
  });

  it('cadence resumes after the backlog (no more back-to-back)', () => {
    // PPL trainingDays=3 → normal cadence offsets [0, 2, 4] (Mon/Wed/Fri).
    // backlog 2 → catch-up on today, today+1; cadence then anchors at
    // today+2 with offsets [0, 2, 4] → today+2, today+4, today+6.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 2,
      mesocyclePosition: 0,
    });
    const all = flatten(rows);
    // First 2 are back-to-back; session #3 has at least a 1-day gap.
    const gap2to3 = (Date.parse(all[2].date) - Date.parse(all[1].date)) / 86400000;
    expect(gap2to3).toBeGreaterThanOrEqual(1);
    // Specifically: post-catch-up sessions follow [0, 2, 4] from today+2.
    expect(all[2].date).toBe(addDays(baseArgs.todayIso, 2));
    expect(all[3].date).toBe(addDays(baseArgs.todayIso, 4));
    expect(all[4].date).toBe(addDays(baseArgs.todayIso, 6));
  });

  it('CROSS-WEEK: N=8 still produces 8 consecutive days from today', () => {
    // Backlog exceeds a 7-day window. All 8 catch-up sessions still pack
    // back-to-back, crossing into the next calendar week.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 8,
      mesocyclePosition: 0,
      horizonWeeks: 4,
    });
    const all = flatten(rows);
    for (let i = 0; i < 8; i++) {
      expect(all[i].date).toBe(addDays(baseArgs.todayIso, i));
    }
  });

  it('buckets sessions into 7-day rows anchored at today, today+7, today+14, today+21', () => {
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 3,
      mesocyclePosition: 0,
    });
    expect(rows.map(r => r.weekStart)).toEqual([
      baseArgs.todayIso,
      addDays(baseArgs.todayIso, 7),
      addDays(baseArgs.todayIso, 14),
      addDays(baseArgs.todayIso, 21),
    ]);
    // Every PlanDay's date falls within its row's [weekStart, weekStart+6].
    for (const row of rows) {
      const end = addDays(row.weekStart, 6);
      for (const d of row.planDays) {
        expect(d.date! >= row.weekStart).toBe(true);
        expect(d.date! <= end).toBe(true);
      }
    }
  });
});

describe('buildCatchUpRows — idempotency', () => {
  it('backlog 0 → no catch-up sessions; first session uses normal cadence', () => {
    // The dashboard gates on backlogN > 0 before calling this builder;
    // the no-op invariant is still meaningful for the unit-level
    // contract: with no backlog, the FIRST training session falls on
    // pickDefaultDayOffsets(3)[0] === 0 from today, and gaps follow.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 0,
      mesocyclePosition: 0,
    });
    const all = flatten(rows);
    expect(all[0].date).toBe(baseArgs.todayIso); // offset 0 of cadence
    expect(all[1].date).toBe(addDays(baseArgs.todayIso, 2));
    expect(all[2].date).toBe(addDays(baseArgs.todayIso, 4));
  });

  it('re-running with backlog 0 produces the same plan (no compounding)', () => {
    // The catch-up builder is pure: same inputs → same output. This
    // guards against accidental state leaks (e.g. a previous call's
    // dayIndexOffset bleeding into the next).
    const args = { ...baseArgs, backlogN: 0, mesocyclePosition: 5 };
    const once = buildCatchUpRows(args);
    const twice = buildCatchUpRows(args);
    expect(flatten(twice.rows).map(s => `${s.date}|${s.workoutType}`))
      .toEqual(flatten(once.rows).map(s => `${s.date}|${s.workoutType}`));
  });
});

// ── Skip-ahead semantics ──────────────────────────────────────────────
// The GapModal "Skip ahead" button doesn't restart the plan — it
// invokes buildCatchUpRows with backlogN: 0 and mesocyclePosition
// advanced by the missed count. Today therefore becomes the canonical
// NEXT session after the misses, on normal cadence.

describe('buildCatchUpRows — skip-ahead semantics', () => {
  it('PPL: missed chest+back (treated as positions 0,1) → today = shoulders/legs at position 2', () => {
    // The handler calls buildCatchUpRows with:
    //   backlogN: 0
    //   mesocyclePosition: completedCount + missedCount
    // PPL dayTypes = [push, pull, legs]. Pretend the user completed
    // 0 sessions and missed 2 — handler computes mesocyclePosition = 2.
    // Today = dayTypes[2 % 3] = legs (the position-2 type).
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 0,
      mesocyclePosition: 2, // completedCount(0) + missedCount(2)
    });
    const all = flatten(rows);
    // First session is at today on normal cadence offset 0.
    expect(all[0].date).toBe(baseArgs.todayIso);
    // It is the canonical NEXT type after the two skipped positions.
    expect(all[0].workoutType).toBe('Legs');
    // Normal cadence: session #2 is 2 days later (offset 2 in [0,2,4]).
    expect(all[1].date).toBe(addDays(baseArgs.todayIso, 2));
  });

  it('SKIP is idempotent: same args → same plan, no compounding rotation', () => {
    const args = { ...baseArgs, backlogN: 0, mesocyclePosition: 4 };
    const once = buildCatchUpRows(args);
    const twice = buildCatchUpRows(args);
    expect(flatten(twice.rows).map(s => `${s.date}|${s.workoutType}`))
      .toEqual(flatten(once.rows).map(s => `${s.date}|${s.workoutType}`));
  });

  it('SKIP preserves the user\'s mid-block position (blockWeek 3 stays 3, not 1)', () => {
    // Bug 4 verification. A user in block week 3 (last build before
    // deload) taps "Skip ahead." The catch-up builder must respect the
    // passed-in blockWeek and NOT regenerate as a fresh blockWeek 1.
    //
    // We verify two slices of the contract:
    //   • Week-0 sessions of the catch-up output (the active week the
    //     user is in TODAY) are NOT deload — blockWeek 3 is the build
    //     week, not the deload.
    //   • Week-1 sessions (today + 7..13) ARE deload — generatePlan
    //     advances blockWeek by 1 across its internal week loop, so
    //     blockWeek 3 + 1 = 4 = deload.
    //
    // Both observations confirm the block math is preserved end-to-end.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 0,
      mesocyclePosition: 6, // mid-cycle
      blockWeek: 3,
    });
    // Today's row: blockWeek=3 → no deload flag on any PlanDay.
    expect(rows[0].planDays.length).toBeGreaterThan(0);
    expect(rows[0].planDays.every(d => (d as any).deload !== true)).toBe(true);
    // Next week's row: blockWeek=4 → every training day flagged deload.
    expect(rows[1].planDays.length).toBeGreaterThan(0);
    expect(rows[1].planDays.every(d => (d as any).deload === true)).toBe(true);
  });

  it('SKIP from blockWeek 1 produces a build week (no deload until week 4)', () => {
    // Contrast case: a user actually in blockWeek 1 (fresh block) taps
    // Skip. The output should NOT have deload until row index 3 (the 4th
    // week of the catch-up horizon).
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 0,
      mesocyclePosition: 0,
      blockWeek: 1,
    });
    expect(rows[0].planDays.every(d => (d as any).deload !== true)).toBe(true);
    expect(rows[1].planDays.every(d => (d as any).deload !== true)).toBe(true);
    expect(rows[2].planDays.every(d => (d as any).deload !== true)).toBe(true);
    // Row 3 = week 4 of a 4-week block = deload.
    expect(rows[3].planDays.length).toBeGreaterThan(0);
    expect(rows[3].planDays.every(d => (d as any).deload === true)).toBe(true);
  });

  it('SKIP does not restart the rotation when mesocyclePosition is already mid-cycle', () => {
    // User completed 5 PPL sessions (push, pull, legs, push, pull) and
    // missed the next 2 (legs, push). Skip computes mesocyclePosition =
    // 5 + 2 = 7 → today = dayTypes[7 % 3] = pull. The mesocycle is
    // PRESERVED — we don't restart at push (which would happen if skip
    // reset mesocyclePosition to 0).
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 0,
      mesocyclePosition: 7,
    });
    const all = flatten(rows);
    expect(all[0].workoutType).toBe('Pull');
  });

  it('RESUME vs SKIP: contrast — resume uses completedCount, skip uses completedCount + missedCount', () => {
    // Concrete scenario: user completed 0 sessions, missed 2 (chest, back
    // in PPL terms — push, pull). Resume should set today = push (the
    // first missed); skip should set today = legs (the next canonical
    // after the missed pair).
    const resumeArgs = {
      ...baseArgs,
      backlogN: 2,         // make up both
      mesocyclePosition: 0, // start of cycle
    };
    const skipArgs = {
      ...baseArgs,
      backlogN: 0,         // don't make up
      mesocyclePosition: 2, // advance past the missed pair
    };
    const resumeAll = flatten(buildCatchUpRows(resumeArgs).rows);
    const skipAll = flatten(buildCatchUpRows(skipArgs).rows);
    expect(resumeAll[0].workoutType).toBe('Push'); // catch-up day 1 = first missed
    expect(resumeAll[1].workoutType).toBe('Pull'); // catch-up day 2 = second missed (back-to-back)
    expect(skipAll[0].workoutType).toBe('Legs');   // today = canonical NEXT after the pair
    // Skip preserves cadence on day 1 → today; next session is +2 days.
    expect(skipAll[1].date).toBe(addDays(baseArgs.todayIso, 2));
  });
});

describe('buildCatchUpRows — mesocycle phase', () => {
  it('PPL with mesocyclePosition 5 resumes at index 5 % 3 = 2 → legs', () => {
    // After 5 completed PPL sessions (push, pull, legs, push, pull) the
    // next dayType is legs (cycleIndex 5 % 3 = 2). Backlog 1 means one
    // missed session, which is the due-next legs day.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 1,
      mesocyclePosition: 5,
    });
    const all = flatten(rows);
    expect(all[0].workoutType).toBe('Legs');
    // Sanity: today is the first session.
    expect(all[0].date).toBe(baseArgs.todayIso);
    // And the next future session continues the cycle at push.
    expect(all[1].workoutType).toBe('Push');
  });

  it('upper_lower with mesocyclePosition 3 resumes at index 3 % 2 = lower (alternation continues)', () => {
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 2,
      backlogN: 1,
      mesocyclePosition: 3,
    });
    const all = flatten(rows);
    // Upper/Lower alternates. Position 3 → dayTypes[3 % 2] = lower.
    expect(all[0].workoutType).toBe('Lower');
  });

  // ── bro_split resume — phase offset via inWeekStartIndex ──────────────
  // BUG FIX: before inWeekStartIndex existed, the 'fixed' bro_split rotation
  // ignored dayIndexOffset entirely and always restarted at template
  // position 0 (Chest), regardless of completed-session count. A user who
  // had trained Chest/Back/Shoulders and missed Arms always got Chest on
  // their first catch-up day instead of Arms. The fix mirrors how
  // cycle/alternating splits resume rotation, but through a separate param
  // because the fixed template doesn't read dayIndexOffset.
  //
  // dayTypes template: ['chest','back','shoulders','arms','legs'] → length 5.

  it('bro_split resume: mesocyclePosition 7 → first catch-up day is Shoulders, NOT Chest', () => {
    // Position 7 ≡ 2 mod 5 → dayTypes[2] = shoulders. With backlogN 3 the
    // catch-up packs three back-to-back days continuing through the
    // template: shoulders → arms → legs (positions 7,8,9 of the rotation).
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 3,
      mesocyclePosition: 7,
    });
    const all = flatten(rows);
    expect(all[0]).toEqual({ date: baseArgs.todayIso, workoutType: 'Shoulders' });
    expect(all[1]).toEqual({ date: addDays(baseArgs.todayIso, 1), workoutType: 'Arms' });
    expect(all[2]).toEqual({ date: addDays(baseArgs.todayIso, 2), workoutType: 'Legs' });
  });

  it('bro_split resume: future segment continues at the right type after catch-up', () => {
    // backlogN 3 from position 7 lands the future segment at position 10
    // (= 10 % 5 = 0 → chest). Normal cadence for trainingDays=5 is
    // [0,1,3,4,6] anchored at today+3. The first FIVE future training
    // days should walk the full template starting at chest.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 3,
      mesocyclePosition: 7,
    });
    const all = flatten(rows);
    // First 3 are the catch-up (shoulders/arms/legs); next 5 are the
    // future segment's week 0 — chest/back/shoulders/arms/legs.
    expect(all.slice(3, 8).map(s => s.workoutType)).toEqual([
      'Chest', 'Back', 'Shoulders', 'Arms', 'Legs',
    ]);
  });

  it('bro_split skip-ahead (backlogN 0): future starts at the user\'s true next type', () => {
    // Position 4 ≡ 4 → legs. With NO backlog, the future segment alone
    // determines the first session. Anchored at today on normal cadence
    // [0,1,3,4,6], the first training day = today and the workoutType
    // must be legs — the type the user is due to train next.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 0,
      mesocyclePosition: 4,
    });
    const all = flatten(rows);
    expect(all[0]).toEqual({ date: baseArgs.todayIso, workoutType: 'Legs' });
    // Subsequent week-0 training days continue through the template,
    // wrapping back to chest after legs.
    expect(all.slice(0, 5).map(s => s.workoutType)).toEqual([
      'Legs', 'Chest', 'Back', 'Shoulders', 'Arms',
    ]);
  });

  it('bro_split regression: mesocyclePosition 0 still starts at Chest (offset = 0)', () => {
    // The fix must not move the rotation for a fresh user. Position 0
    // mod 5 = 0 → Chest, identical to the pre-fix behavior.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 0,
      mesocyclePosition: 0,
    });
    const all = flatten(rows);
    expect(all[0].workoutType).toBe('Chest');
  });

  it('bro_split exact-week boundary: mesocyclePosition 5 wraps cleanly back to Chest', () => {
    // Position 5 mod 5 = 0 — same as a fresh user. Catches an off-by-one
    // where the mod might land on 1 (Back) instead.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 0,
      mesocyclePosition: 5,
    });
    expect(flatten(rows)[0].workoutType).toBe('Chest');
  });

  it('bro_split: inWeekStartIndex is a no-op for PPL — passing it does not regress cycle splits', () => {
    // Same scenario as the PPL resume test above but explicitly confirms
    // that bro_split's phase-offset machinery does not leak into other
    // splits. PPL position 5 must still resume at Legs via dayIndexOffset.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 1,
      mesocyclePosition: 5,
      // No split specified → splitForDays(3) === 'ppl'.
    });
    expect(flatten(rows)[0].workoutType).toBe('Legs');
  });
});

// ── Resume rotation position derived from the last completed session ───
// Bug: ackGap('resume') passed a raw lifetime completed-session COUNT as
// mesocyclePosition. That count is a fragile proxy — it lands on chest
// (dayTypes[0]) whenever it's a multiple of dayTypes.length or reads 0,
// and drifts on any split change, ad-hoc session, or un-counted
// completion. The fix: home.tsx now resolves mesocyclePosition via
// nextRotationPhase(lastCompletedWorkoutType) instead, falling back to
// the count only when there's no last completed session. This exercises
// the exact composition home.tsx performs: map the last completed type →
// phase → feed into buildCatchUpRows → assert the catch-up starts on the
// correct next type, regardless of what the lifetime count says.

describe('resume rotation position — derived from last completed workout_type', () => {
  it('bro_split: given a last completed session of each type, the catch-up starts on the next type (arms → legs)', () => {
    const dayTypeSequence = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs'];
    for (let i = 0; i < dayTypeSequence.length; i++) {
      const lastCompletedWorkoutType = dayTypeSequence[i];
      const expectedNextType = dayTypeSequence[(i + 1) % dayTypeSequence.length];

      // A wildly wrong lifetime count (0) — if the fallback were still
      // used here, this would incorrectly restart at Chest for any i
      // where completedCount % 5 === 0. The resolved phase must win.
      const phase = nextRotationPhase({
        split: 'bro_split',
        trainingDays: 5,
        lastWorkoutType: lastCompletedWorkoutType,
      });
      expect(phase).not.toBeNull();

      const { rows } = buildCatchUpRows({
        ...baseArgs,
        trainingDays: 5,
        split: 'bro_split',
        backlogN: 1,
        mesocyclePosition: phase!,
      });
      expect(flatten(rows)[0].workoutType).toBe(expectedNextType);
    }
  });

  it('REGRESSION: last completed = Arms → next is Legs, not a chest restart even when completedCount ≡ 0 mod 5', () => {
    // The exact bug report: bro_split, last workout was arms, but the
    // resume offer started at chest. Simulate the failure mode directly —
    // a lifetime count of 10 (≡ 0 mod 5) alongside a last completed type
    // of Arms. The count-based fallback would produce Chest; the
    // type-derived phase must produce Legs.
    const staleCompletedCount = 10; // ≡ 0 mod 5 → would fall through to Chest
    const phase = nextRotationPhase({
      split: 'bro_split',
      trainingDays: 5,
      lastWorkoutType: 'Arms',
    });
    expect(phase).not.toBeNull();
    expect(phase).not.toBe(staleCompletedCount);

    const buggyRows = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 1,
      mesocyclePosition: staleCompletedCount,
    });
    expect(flatten(buggyRows.rows)[0].workoutType).toBe('Chest'); // the bug

    const fixedRows = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 1,
      mesocyclePosition: phase!,
    });
    expect(flatten(fixedRows.rows)[0].workoutType).toBe('Legs'); // the fix
  });

  it('PPL: last completed = Legs → next resolved phase lands on Push (missed-legs property preserved)', () => {
    const phase = nextRotationPhase({ split: 'ppl', trainingDays: 3, lastWorkoutType: 'Legs' });
    expect(phase).not.toBeNull();
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 1,
      mesocyclePosition: phase!,
    });
    expect(flatten(rows)[0].workoutType).toBe('Push');
  });

  it('falls back to the count-based phase when there is no resolvable last-completed type (true cold start)', () => {
    const phase = nextRotationPhase({ split: 'bro_split', trainingDays: 5, lastWorkoutType: null });
    expect(phase).toBeNull();
    // Caller's fallback: `resolvedPhase ?? completedCount`. With no history
    // at all completedCount is 0 too — catch-up starts at Chest, same as
    // any brand-new user.
    const fallbackCompletedCount = 0;
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      trainingDays: 5,
      split: 'bro_split',
      backlogN: 1,
      mesocyclePosition: phase ?? fallbackCompletedCount,
    });
    expect(flatten(rows)[0].workoutType).toBe('Chest');
  });
});

// ── Row-coverage invariants ───────────────────────────────────────────
// The bug these tests pin: without a stable 7-day grid AND a clear-before-
// rewrite delete that catches today-covering rows, two runs on different
// weekdays produce partially-overlapping rows and the same calendar date
// maps to two different workout types. The invariants make that
// structurally impossible.

/** Inclusive last-covered date for a row. */
function endOf(row: { weekStart: string }): string {
  return addDays(row.weekStart, 6);
}

function pairsOverlap(rows: Array<{ weekStart: string }>): boolean {
  const sorted = [...rows].sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0,
  );
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].weekStart <= endOf(sorted[i - 1])) return true;
  }
  return false;
}

function everyDayIsInsideItsRow(rows: Array<{ weekStart: string; planDays: Array<{ date?: string }> }>): boolean {
  for (const row of rows) {
    const end = endOf(row);
    for (const d of row.planDays) {
      if (!d.date) return false;
      if (d.date < row.weekStart || d.date > end) return false;
    }
  }
  return true;
}

describe('buildCatchUpRows — row-coverage invariants', () => {
  it('NEVER produces two rows with overlapping [weekStart, weekStart+6] windows', () => {
    // Sweep across a range of (today, backlog, gridAnchor) combinations
    // to expose any windowing bug rather than testing one scenario.
    const scenarios = [
      { todayIso: '2026-06-06', backlogN: 0,  mesocyclePosition: 0 },
      { todayIso: '2026-06-06', backlogN: 3,  mesocyclePosition: 0 },
      { todayIso: '2026-06-06', backlogN: 8,  mesocyclePosition: 2 },
      { todayIso: '2026-06-08', backlogN: 0,  mesocyclePosition: 5, trainingDays: 4 },
      { todayIso: '2026-06-10', backlogN: 5,  mesocyclePosition: 7, trainingDays: 5, fitnessLevel: 'intermediate' as 'beginner' | 'intermediate' | 'advanced' },
    ];
    for (const s of scenarios) {
      const { rows } = buildCatchUpRows({ ...baseArgs, ...s });
      expect(pairsOverlap(rows)).toBe(false);
      expect(everyDayIsInsideItsRow(rows)).toBe(true);
    }
  });

  it('every PlanDay date is INSIDE its own row window (no cross-row leaks)', () => {
    const { rows } = buildCatchUpRows({ ...baseArgs, backlogN: 8, mesocyclePosition: 0 });
    expect(everyDayIsInsideItsRow(rows)).toBe(true);
  });

  it('every calendar date in the horizon resolves to AT MOST ONE row', () => {
    const { rows } = buildCatchUpRows({ ...baseArgs, backlogN: 3, mesocyclePosition: 0 });
    // For each row, build the set of dates it covers and assert the
    // intersection with every other row is empty.
    const setFor = (r: { weekStart: string }): Set<string> => {
      const s = new Set<string>();
      for (let i = 0; i < 7; i++) s.add(addDays(r.weekStart, i));
      return s;
    };
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = setFor(rows[i]);
        const b = setFor(rows[j]);
        for (const d of a) {
          expect(b.has(d)).toBe(false);
        }
      }
    }
  });

  it('the row covering today is uniquely identifiable (exactly one row contains today)', () => {
    const { rows } = buildCatchUpRows({ ...baseArgs, backlogN: 2, mesocyclePosition: 0 });
    const containingToday = rows.filter(
      r => r.weekStart <= baseArgs.todayIso && baseArgs.todayIso <= endOf(r),
    );
    expect(containingToday).toHaveLength(1);
  });
});

// ── Real-account repro: resume position ───────────────────────────────
// Account intr@gmail.com, 2026-06-11. PPL / 3-day, 10 completed sessions
// (clean P→P→L cycle, last = Push Mon Jun 8), plan anchored Mon May 18,
// today Thu Jun 11, backlog 1 (Pull Wed Jun 10 — see gapDetection.test).
// Resume must land TODAY on Pull (position 10 of the cycle: 10 % 3 = 1),
// not skip to Legs, and the current week must stay a full PPL week.

describe('REPRO intr@gmail.com — resume lands on Pull and keeps a full week', () => {
  const reproArgs = {
    todayIso: '2026-06-11',          // Thursday
    backlogN: 1,                     // only Pull Jun 10 is owed
    mesocyclePosition: 10,           // 10 completed sessions
    trainingDays: 3,
    fitnessLevel: 'beginner' as const,
    location: 'gym' as const,
    planHistory: [],
    blockIndex: 0,
    blockWeek: 1, // block position doesn't affect rotation/dates under test
    horizonWeeks: 4,
    gridAnchor: '2026-05-18',        // the account's earliest plan row (Mon)
  };

  it('the next workout is Pull, today — not Legs', () => {
    const all = flatten(buildCatchUpRows(reproArgs).rows);
    expect(all[0]).toEqual({ date: '2026-06-11', workoutType: 'Pull' });
  });

  it('the current week is a full, correctly-sequenced PPL week (not a 2-day collapse)', () => {
    const { rows } = buildCatchUpRows(reproArgs);
    // Grid anchored Mon May 18 → the active row is Jun 8–14.
    expect(rows[0].weekStart).toBe('2026-06-08');
    const week = rows[0].planDays
      .slice()
      .sort((a, b) => (a.date! < b.date! ? -1 : 1));
    expect(week.map(d => d.workoutType)).toEqual(['Pull', 'Legs', 'Push']);
    expect(week.map(d => d.date)).toEqual(['2026-06-11', '2026-06-12', '2026-06-14']);
  });

  it('the rotation continues unbroken through future weeks (correct PPL cycling)', () => {
    const all = flatten(buildCatchUpRows(reproArgs).rows);
    const cycle = ['Push', 'Pull', 'Legs'];
    // Starting at Pull (position 10), every subsequent session advances
    // the cycle by exactly one — no skips, no restarts.
    for (let i = 0; i < all.length; i++) {
      expect(all[i].workoutType).toBe(cycle[(10 + i) % 3]);
    }
    // And there's plenty of horizon (4 rows × 3 sessions, minus tail spill).
    expect(all.length).toBeGreaterThanOrEqual(9);
  });
});

// ── Current-week self-heal ────────────────────────────────────────────
// The stored active row is a cache of the canonical generation. The heal
// derives the truth from generatePlan at the user's true position
// (completed-session count before the week + block math) and corrects any
// deviating stored state — no manual row deletion required.

describe('healCurrentWeekRow — corrupted current week self-heals', () => {
  // The intr@gmail.com active week, canonical: week_start Mon Jun 8,
  // 9 sessions completed before the week (position 9 ≡ 0 → Push first):
  // Push Jun 8, Pull Jun 10, Legs Jun 12.
  const healArgs = {
    weekStartIso: '2026-06-08',
    completedBeforeWeek: 9,
    trainingDays: 3,
    fitnessLevel: 'beginner' as const,
    location: 'gym' as const,
    blockIndex: 0,
    blockWeek: 1,
  };
  const pairs = (days: Array<{ date?: string; workoutType: string }>) =>
    days
      .map(d => ({ date: d.date, workoutType: d.workoutType }))
      .sort((a, b) => (a.date! < b.date! ? -1 : 1));

  it('the corrupted 2-day "Legs, Push" row is replaced by the full canonical week', () => {
    // The observed corruption: the current week collapsed to two
    // wrong-typed days. The heal must NOT trust it.
    const corrupted = [
      { day: 'Thursday', date: '2026-06-11', workoutType: 'Legs', location: 'gym', muscleGroups: [], exercises: [] },
      { day: 'Saturday', date: '2026-06-13', workoutType: 'Push', location: 'gym', muscleGroups: [], exercises: [] },
    ] as any[];
    const { healed, days } = healCurrentWeekRow(corrupted, healArgs);
    expect(healed).toBe(true);
    expect(pairs(days)).toEqual([
      { date: '2026-06-08', workoutType: 'Push' },
      { date: '2026-06-10', workoutType: 'Pull' },
      { date: '2026-06-12', workoutType: 'Legs' },
    ]);
  });

  it('IDEMPOTENT: healing the healed output is a no-op (no drift on re-run)', () => {
    const first = healCurrentWeekRow(null, healArgs); // null stored → fresh canonical
    expect(first.healed).toBe(true);
    const second = healCurrentWeekRow(first.days, healArgs);
    expect(second.healed).toBe(false);
    expect(second.days).toBe(first.days); // same reference, untouched
    const third = healCurrentWeekRow(second.days, healArgs);
    expect(third.healed).toBe(false);
    expect(pairs(third.days)).toEqual(pairs(first.days));
  });

  it('a stored row with matching dates/types but different exercises is NOT clobbered', () => {
    // Exercise selection varies with planHistory (variety scoring) —
    // never a reason to rewrite a healthy in-progress week.
    const stored = deriveCanonicalWeek(healArgs).map(d => ({
      ...d,
      exercises: [{ name: 'Some Other Lift', equipment: 'barbell', primaryMuscle: 'Chest', sets: 3, reps: '8', restSeconds: 90 }],
    })) as any[];
    const { healed, days } = healCurrentWeekRow(stored, healArgs);
    expect(healed).toBe(false);
    expect(days).toBe(stored);
  });

  it('future weeks derived at advancing positions stay correct PPL', () => {
    // Next week (Jun 15), position 12 (≡ 0): Push → Pull → Legs again.
    const nextWeek = deriveCanonicalWeek({
      ...healArgs,
      weekStartIso: '2026-06-15',
      completedBeforeWeek: 12,
    });
    expect(pairs(nextWeek as any)).toEqual([
      { date: '2026-06-15', workoutType: 'Push' },
      { date: '2026-06-17', workoutType: 'Pull' },
      { date: '2026-06-19', workoutType: 'Legs' },
    ]);
    // Mid-cycle position carries through too: position 10 → Pull first.
    const midCycle = deriveCanonicalWeek({
      ...healArgs,
      completedBeforeWeek: 10,
    });
    expect(pairs(midCycle as any).map(d => d.workoutType)).toEqual(['Pull', 'Legs', 'Push']);
  });

  it('weekRowMatchesCanonical compares (date, type) pairs order-independently', () => {
    const canonical = deriveCanonicalWeek(healArgs);
    const shuffled = [...canonical].reverse();
    expect(weekRowMatchesCanonical(shuffled, canonical)).toBe(true);
    expect(weekRowMatchesCanonical(null, canonical)).toBe(false);
    expect(weekRowMatchesCanonical([], canonical)).toBe(false);
  });
});

describe('buildCatchUpRows — stable 7-day grid (gridAnchor)', () => {
  it('GRID STABILITY: two runs on different weekdays of the same week → IDENTICAL row weekStarts', () => {
    // Plan anchor pinned to a Monday. Run #1 on Wednesday, run #2 on
    // Saturday — both inside the same anchor-relative week. Their row
    // weekStarts must MATCH. Without gridAnchor, run #1 would anchor at
    // Wednesday and run #2 at Saturday, producing overlapping rows.
    const ANCHOR = '2026-06-01'; // Monday
    const wedRun = buildCatchUpRows({
      ...baseArgs,
      todayIso: '2026-06-03', // Wed
      backlogN: 1,
      mesocyclePosition: 0,
      gridAnchor: ANCHOR,
    });
    const satRun = buildCatchUpRows({
      ...baseArgs,
      todayIso: '2026-06-06', // Sat, same anchor-week
      backlogN: 1,
      mesocyclePosition: 0,
      gridAnchor: ANCHOR,
    });
    expect(wedRun.rows.map(r => r.weekStart)).toEqual(satRun.rows.map(r => r.weekStart));
    // And of course: each run's rows are themselves non-overlapping.
    expect(pairsOverlap(wedRun.rows)).toBe(false);
    expect(pairsOverlap(satRun.rows)).toBe(false);
  });

  it('GRID STABILITY: runs in adjacent anchor-weeks produce rows that DO NOT partially overlap', () => {
    // Run #1 on the last day of an anchor week, run #2 on the first day
    // of the next anchor week. Their grids advance by exactly 7 days —
    // not by some other offset that would let row[i] of run #1 share
    // calendar dates with row[i] of run #2.
    const ANCHOR = '2026-06-01';
    const lateWeek1 = buildCatchUpRows({
      ...baseArgs,
      todayIso: '2026-06-07', // Sunday, last day of week 1
      backlogN: 0,
      mesocyclePosition: 0,
      gridAnchor: ANCHOR,
    });
    const earlyWeek2 = buildCatchUpRows({
      ...baseArgs,
      todayIso: '2026-06-08', // Monday, first day of week 2
      backlogN: 0,
      mesocyclePosition: 0,
      gridAnchor: ANCHOR,
    });
    // Combined set still has no overlap pair-wise IF we take the same
    // index from each — those rows are exactly one week apart, by
    // construction.
    for (let i = 0; i < Math.min(lateWeek1.rows.length, earlyWeek2.rows.length); i++) {
      const a = lateWeek1.rows[i].weekStart;
      const b = earlyWeek2.rows[i].weekStart;
      // Exactly seven days apart.
      const days = (Date.parse(b) - Date.parse(a)) / 86400000;
      expect(days).toBe(7);
    }
  });

  it('without gridAnchor (legacy / no-anchor caller), rows still observe the non-overlap invariant', () => {
    const { rows } = buildCatchUpRows({ ...baseArgs, backlogN: 5, mesocyclePosition: 3 });
    expect(pairsOverlap(rows)).toBe(false);
    expect(everyDayIsInsideItsRow(rows)).toBe(true);
  });

  it('the row containing today has weekStart ≤ today ≤ weekStart+6 (today is always covered)', () => {
    const ANCHOR = '2026-06-01';
    for (const todayIso of ['2026-06-01', '2026-06-04', '2026-06-07', '2026-06-08', '2026-06-15']) {
      const { rows } = buildCatchUpRows({
        ...baseArgs,
        todayIso,
        backlogN: 0,
        mesocyclePosition: 0,
        gridAnchor: ANCHOR,
      });
      // The first row must contain today.
      expect(rows[0].weekStart <= todayIso).toBe(true);
      expect(endOf(rows[0]) >= todayIso).toBe(true);
    }
  });
});

// ── Earned-deload gate (Root Cause fix) ─────────────────────────────────
// Every write path (planSync main loop, self-heal derivation, catch-up
// resume) is supposed to funnel its (blockIndex, blockWeek) through
// src/lib/blockPosition.ts::resolveBlockPosition. These fixtures pin the
// end-to-end shape of the materialized week for each ROOT scenario the
// spec lists.

describe('resume path: idle-returner catch-up does NOT materialize a phantom deload', () => {
  it('returning idle user AT calendar wk4 → future segment has NO deload day', () => {
    // Simulate the exact failure the PR set out to fix: the user's plan
    // anchor was 3 calendar weeks ago (blockIndex 0 wk 4 on the calendar),
    // they haven't trained the block (blockCompletedSessions=0), and they
    // just resumed. The resume pack MUST NOT emit a deload week — under
    // the gate, calendar wk4 resets to (blockIndex+1, wk1).
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 0, // pure skip-ahead resume
      mesocyclePosition: 0,
      blockIndex: 0,
      blockWeek: 4, // caller already-resolved via resolveBlockPosition
      blockCompletedSessions: 0,
    });
    for (const row of rows) {
      for (const day of row.planDays) {
        expect(day.deload).not.toBe(true);
      }
    }
  });

  it('returning idle user with a backlog: neither catch-up nor future has a deload day', () => {
    // Caller (home.tsx) applies resolveBlockPosition BEFORE invoking
    // buildCatchUpRows — so an idle returner rolling into calendar wk4
    // arrives with (blockIndex+1, wk1), not raw (blockIndex, wk4). The
    // catch-up segment uses those inputs directly and the future segment
    // gates each week internally via blockCompletedSessions.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 2,
      mesocyclePosition: 0,
      blockIndex: 1, // post-reset (caller applied the gate)
      blockWeek: 1,  // post-reset
      blockCompletedSessions: 0,
    });
    const flat = flatten(rows);
    expect(flat.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const day of row.planDays) {
        expect(day.deload).not.toBe(true);
      }
    }
  });

  it('legacy caller (no blockCompletedSessions) keeps the old single-batch behaviour', () => {
    // Back-compat: any test/caller that doesn't pass the count still
    // generates future segment in one call and materializes wk4 as a
    // deload if the caller supplied blockWeek=4.
    const { rows } = buildCatchUpRows({
      ...baseArgs,
      backlogN: 0,
      mesocyclePosition: 0,
      blockIndex: 0,
      blockWeek: 4,
      // blockCompletedSessions deliberately omitted
    });
    // The first week's days should carry deload:true (raw calendar wk4).
    const firstRowDays = rows[0].planDays;
    expect(firstRowDays.some(d => d.deload === true)).toBe(true);
  });
});

describe('deriveCanonicalWeek: honors the caller-resolved position (earned vs unearned)', () => {
  // planSync's caller applies resolveBlockPosition before invoking
  // deriveCanonicalWeek, so this test exercises the shape the canonical
  // takes at each side of the gate.

  it('idle account, calendar wk4 → passed as (blockIndex+1, 1) → NON-deload canonical', () => {
    // What planSync's resolvePosition returns for weeksFromAnchor=3 +
    // blockCompletedSessions=0: { blockIndex: 1, blockWeek: 1 }. The
    // derived canonical week that plays into the self-heal must NOT
    // contain a deload day.
    const canonical = deriveCanonicalWeek({
      weekStartIso: '2026-06-06',
      completedBeforeWeek: 0,
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 1, // post-reset
      blockWeek: 1,  // post-reset
    });
    expect(canonical.length).toBeGreaterThan(0);
    for (const day of canonical) {
      expect(day.deload).not.toBe(true);
    }
  });

  it('trained account, calendar wk4 → passed as (blockIndex, 4) → real deload canonical', () => {
    // Same calendar position but with 5 completed sessions: the caller's
    // resolvePosition yields {0, 4}. The canonical MUST still contain the
    // deload — the gate doesn't rob a real trained block of its recovery.
    const canonical = deriveCanonicalWeek({
      weekStartIso: '2026-06-06',
      completedBeforeWeek: 5,
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 0,
      blockWeek: 4,
    });
    expect(canonical.length).toBeGreaterThan(0);
    // Every generated day carries deload=true when blockWeek === 4.
    for (const day of canonical) {
      expect(day.deload).toBe(true);
    }
  });
});

describe('determinism: trained blocks still return identical lifts across weeks 1–3', () => {
  it('same block, weeks 1/2/3 produce IDENTICAL exercise selection (progressive-overload substrate)', () => {
    // The gate must not disturb the within-block substrate. Weeks 1–3 at
    // the same blockIndex use the same seeded picker, so the exercise
    // names are byte-identical (only sets/reps vary with the ramp).
    const wk1 = deriveCanonicalWeek({
      weekStartIso: '2026-06-01',
      completedBeforeWeek: 0,
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 0,
      blockWeek: 1,
    });
    const wk2 = deriveCanonicalWeek({
      weekStartIso: '2026-06-08',
      completedBeforeWeek: 3, // one week's training
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 0,
      blockWeek: 2,
    });
    const wk3 = deriveCanonicalWeek({
      weekStartIso: '2026-06-15',
      completedBeforeWeek: 6,
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 0,
      blockWeek: 3,
    });
    const names = (days: typeof wk1) =>
      days.flatMap(d => d.exercises.map(e => e.name));
    expect(names(wk1)).toEqual(names(wk2));
    expect(names(wk2)).toEqual(names(wk3));
  });

  it('a reset advances blockIndex (fresh selection) — the INTENDED fresh-start behavior', () => {
    // Regression guard for the "reset means new lifts" contract. When
    // the gate rolls (0, wk4) → (1, wk1), the exercise selection shifts
    // to the new block's seeded shuffle — that's the fresh-start
    // property the spec calls out.
    const block0 = deriveCanonicalWeek({
      weekStartIso: '2026-06-01',
      completedBeforeWeek: 0,
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 0,
      blockWeek: 1,
    });
    const block1 = deriveCanonicalWeek({
      weekStartIso: '2026-06-22',
      completedBeforeWeek: 0,
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 1, // post-reset from an unearned wk4
      blockWeek: 1,
    });
    const names = (days: typeof block0) =>
      days.flatMap(d => d.exercises.map(e => e.name));
    // Different seeded picker per blockIndex → at least ONE lift differs
    // across blocks. (Not every lift — the primary compound anchor may
    // repeat because it's the highest-scoring option.)
    const b0 = names(block0);
    const b1 = names(block1);
    const overlap = b0.filter(n => b1.includes(n)).length;
    expect(overlap).toBeLessThan(b0.length); // at least one shift
  });
});
