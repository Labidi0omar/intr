import { hasEntryForDate } from './journalLock';

const TODAY = '2026-06-15';
const YESTERDAY = '2026-06-14';

describe('hasEntryForDate — once-per-day journal lock', () => {
  it('locks when an entry for TODAY exists (read-only view is shown)', () => {
    const entries = [{ date: YESTERDAY }, { date: TODAY }];
    expect(hasEntryForDate(entries, TODAY)).toBe(true);
  });

  it('does NOT lock when there is no entry for today (editor renders)', () => {
    expect(hasEntryForDate([], TODAY)).toBe(false);
    expect(hasEntryForDate([{ date: '2026-06-10' }], TODAY)).toBe(false);
  });

  it('a yesterday-only entry does NOT lock today (clean date rollover)', () => {
    expect(hasEntryForDate([{ date: YESTERDAY }], TODAY)).toBe(false);
  });

  it('error-tolerant: null/garbage inputs collapse to "not locked"', () => {
    expect(hasEntryForDate(null, TODAY)).toBe(false);
    expect(hasEntryForDate(undefined, TODAY)).toBe(false);
    expect(hasEntryForDate([null, undefined, {}], TODAY)).toBe(false);
    expect(hasEntryForDate([{ date: null }, { date: undefined }], TODAY)).toBe(false);
    expect(hasEntryForDate([{ date: TODAY }], '')).toBe(false);
    expect(hasEntryForDate([{ date: TODAY }], null)).toBe(false);
  });

  it('matches on the exact calendar-date string (same key as the upsert)', () => {
    // No fuzzy/timestamp matching — only the YYYY-MM-DD key counts.
    expect(hasEntryForDate([{ date: '2026-06-15T00:00:00' }], TODAY)).toBe(false);
    expect(hasEntryForDate([{ date: TODAY }], TODAY)).toBe(true);
  });
});
