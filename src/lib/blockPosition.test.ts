/// <reference types="node" />
// Unit tests for the earned-deload gate. Every other test in this repo
// that touches materialization (planSync's own tests, planCatchUp's own
// tests) inherits this gate's behaviour by way of resolveBlockPosition —
// these fixtures pin the gate's raw contract.

import { DELOAD_EARN_FLOOR, resolveBlockPosition } from './blockPosition';

describe('resolveBlockPosition — earned-deload gate', () => {
  it('the constant is what the doc says (3 sessions of the block\'s weeks 1–3)', () => {
    expect(DELOAD_EARN_FLOOR).toBe(3);
  });

  it('weeks 1–3 pass through the raw calendar formula regardless of session count', () => {
    // The gate only reshapes calendar week 4. Weeks 1, 2, 3 are always
    // "at their calendar position" — a low session count doesn't advance
    // them, and a high count doesn't roll them forward.
    for (const done of [0, 3, 10]) {
      expect(resolveBlockPosition({ weeksFromAnchor: 0, blockCompletedSessions: done }))
        .toEqual({ blockIndex: 0, blockWeek: 1 });
      expect(resolveBlockPosition({ weeksFromAnchor: 1, blockCompletedSessions: done }))
        .toEqual({ blockIndex: 0, blockWeek: 2 });
      expect(resolveBlockPosition({ weeksFromAnchor: 2, blockCompletedSessions: done }))
        .toEqual({ blockIndex: 0, blockWeek: 3 });
    }
  });

  it('UNEARNED calendar week-4 (< 3 sessions) → reset to next block wk1', () => {
    // The load-bearing case for the whole PR: an idle user rolling into
    // calendar week 4 must NOT materialize a deload. blockIndex advances
    // (fresh selection), blockWeek is 1 (base volume, not reduced).
    for (const done of [0, 1, 2]) {
      expect(resolveBlockPosition({ weeksFromAnchor: 3, blockCompletedSessions: done }))
        .toEqual({ blockIndex: 1, blockWeek: 1 });
    }
    // The same reset shape holds at any subsequent block boundary.
    expect(resolveBlockPosition({ weeksFromAnchor: 7, blockCompletedSessions: 0 }))
      .toEqual({ blockIndex: 2, blockWeek: 1 });
    expect(resolveBlockPosition({ weeksFromAnchor: 11, blockCompletedSessions: 2 }))
      .toEqual({ blockIndex: 3, blockWeek: 1 });
  });

  it('EARNED calendar week-4 (≥ 3 sessions) → real deload at raw calendar position', () => {
    // The bright-line counter-check: the gate must NOT rob a trained
    // block of its deload week.
    for (const done of [3, 4, 5, 10]) {
      expect(resolveBlockPosition({ weeksFromAnchor: 3, blockCompletedSessions: done }))
        .toEqual({ blockIndex: 0, blockWeek: 4 });
    }
    expect(resolveBlockPosition({ weeksFromAnchor: 7, blockCompletedSessions: 5 }))
      .toEqual({ blockIndex: 1, blockWeek: 4 });
  });

  it('legacy callers (no session count) get the raw calendar behavior (back-compat)', () => {
    // Wire-in is per-call; existing untouched sites must observe no
    // change. undefined AND missing both mean "no gate."
    expect(resolveBlockPosition({ weeksFromAnchor: 3 }))
      .toEqual({ blockIndex: 0, blockWeek: 4 });
    expect(resolveBlockPosition({ weeksFromAnchor: 3, blockCompletedSessions: undefined }))
      .toEqual({ blockIndex: 0, blockWeek: 4 });
    // Non-finite → treated as "no signal", same as missing.
    expect(resolveBlockPosition({ weeksFromAnchor: 3, blockCompletedSessions: NaN }))
      .toEqual({ blockIndex: 0, blockWeek: 4 });
  });

  it('defensive: negative or non-finite weeksFromAnchor collapses to week 1 of block 0', () => {
    expect(resolveBlockPosition({ weeksFromAnchor: -3 }))
      .toEqual({ blockIndex: 0, blockWeek: 1 });
    expect(resolveBlockPosition({ weeksFromAnchor: NaN }))
      .toEqual({ blockIndex: 0, blockWeek: 1 });
  });

  it('deterministic: same inputs → same output', () => {
    const args = { weeksFromAnchor: 3, blockCompletedSessions: 2 };
    expect(resolveBlockPosition(args)).toEqual(resolveBlockPosition(args));
  });
});
