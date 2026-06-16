// One-entry-per-calendar-day UI lock for the journal.
//
// Pure + deterministic so the lock decision is unit-testable without
// rendering the screen. The journal screen is one-row-per-day in the DB
// (journal_entries upserts on user_id,date); this mirrors that on the UI:
// once an entry exists for the user's LOCAL calendar date, the editor is
// replaced by a read-only view until the date rolls over.
//
// Gated purely on the YYYY-MM-DD string so it matches the upsert key exactly
// — a yesterday entry can never lock today, and today's lock clears at local
// midnight (the caller passes a freshly-computed `today`). Error-tolerant:
// null/garbage entries and a missing `today` collapse to "not locked".

export interface DatedEntryLike {
  date?: string | null;
}

/**
 * True iff `entries` contains an entry whose `date` equals `today`
 * (local YYYY-MM-DD). When true, the journal screen shows the read-only
 * "you've journaled today" view instead of the editor + submit.
 */
export function hasEntryForDate(
  entries: ReadonlyArray<DatedEntryLike | null | undefined> | null | undefined,
  today: string | null | undefined,
): boolean {
  if (!today) return false;
  if (!Array.isArray(entries)) return false;
  for (const e of entries) {
    if (e && e.date === today) return true;
  }
  return false;
}
