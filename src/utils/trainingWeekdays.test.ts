import {
  normalizeTrainingWeekdays,
  weekdaysToOffsets,
  hasConsecutiveRun,
} from './trainingWeekdays';

describe('normalizeTrainingWeekdays', () => {
  it('deduplicates and sorts ascending', () => {
    expect(normalizeTrainingWeekdays([3, 1, 5, 1, 3])).toEqual([1, 3, 5]);
  });

  it('drops out-of-range and non-integer entries', () => {
    expect(normalizeTrainingWeekdays([1, 7, -1, 3.5, 'x' as any])).toEqual([1]);
  });

  it('null / non-array / empty → null (caller falls back to defaults)', () => {
    expect(normalizeTrainingWeekdays(null)).toBeNull();
    expect(normalizeTrainingWeekdays(undefined)).toBeNull();
    expect(normalizeTrainingWeekdays('mon,wed,fri' as any)).toBeNull();
    expect(normalizeTrainingWeekdays([])).toBeNull();
  });
});

describe('weekdaysToOffsets', () => {
  // 2026-06-14 is a Sunday (per JS Date(year, month-1, day).getDay()).
  // Pinned dates below are picked to test specific weekday anchors.

  it('Mon/Wed/Fri anchored to a Sunday → [1, 3, 5]', () => {
    expect(weekdaysToOffsets([1, 3, 5], '2026-06-14')).toEqual([1, 3, 5]);
  });

  it('Mon/Wed/Fri anchored to a Wednesday → [0, 2, 5] (sorted)', () => {
    // 2026-06-17 is a Wednesday.
    expect(weekdaysToOffsets([1, 3, 5], '2026-06-17')).toEqual([0, 2, 5]);
  });

  it('Sat-only anchored to a Monday → [5]', () => {
    // 2026-06-15 is a Monday. Sat = 6 → (6-1+7)%7 = 5.
    expect(weekdaysToOffsets([6], '2026-06-15')).toEqual([5]);
  });

  it('null / empty → null so the caller can fall back to defaults', () => {
    expect(weekdaysToOffsets(null, '2026-06-14')).toBeNull();
    expect(weekdaysToOffsets([], '2026-06-14')).toBeNull();
  });

  it('all 7 weekdays → [0..6] regardless of start day', () => {
    expect(weekdaysToOffsets([0, 1, 2, 3, 4, 5, 6], '2026-06-15')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekdaysToOffsets([0, 1, 2, 3, 4, 5, 6], '2026-06-17')).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('idempotent across weeks: same weekday list, same offsets when both anchors share the same DOW', () => {
    // Two Sundays a week apart must produce identical offsets.
    expect(weekdaysToOffsets([2, 4], '2026-06-14')).toEqual(
      weekdaysToOffsets([2, 4], '2026-06-21'),
    );
  });
});

describe('hasConsecutiveRun', () => {
  it('Mon/Tue/Wed → true at length 3 (true run)', () => {
    expect(hasConsecutiveRun([1, 2, 3], 3)).toBe(true);
  });

  it('Mon/Wed/Fri → false at length 3 (alternating)', () => {
    expect(hasConsecutiveRun([1, 3, 5], 3)).toBe(false);
  });

  it('Sat/Sun/Mon → true at length 3 (wraps across the week)', () => {
    // 6 (Sat) → 0 (Sun) → 1 (Mon) is consecutive when treated as a cycle.
    expect(hasConsecutiveRun([6, 0, 1], 3)).toBe(true);
  });

  it('null / fewer than runLen entries → false', () => {
    expect(hasConsecutiveRun(null)).toBe(false);
    expect(hasConsecutiveRun([1, 2])).toBe(false);
  });
});
