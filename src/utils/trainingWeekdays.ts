// Helpers for the user-selected weekday picker (onboarding + Profile).
// `training_weekdays` (profiles column) stores day-of-week indices in the
// JS Date.getDay() convention: 0=Sun, 1=Mon, … 6=Sat. The generator does
// NOT consume weekday indices directly — it takes `selectedDayOffsets`
// counted from `startDate` (a YYYY-MM-DD). This file is the conversion
// boundary, pure + tested so the heal path and the initial generation
// agree by construction.

/** True when `n` is an integer in [0, 6]. */
function isValidWeekday(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6;
}

/** Parse / clean a stored value into a deduped, in-range, sorted weekday
 *  array. Anything not in [0,6] is dropped. NULL / non-array → null. */
export function normalizeTrainingWeekdays(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<number>();
  for (const v of raw) {
    if (isValidWeekday(v)) out.add(v);
  }
  if (out.size === 0) return null;
  return Array.from(out).sort((a, b) => a - b);
}

/** Day-of-week for a YYYY-MM-DD local-date string. Uses local-construction
 *  (year, month-1, day) so a "2026-06-15" input always lands on the local
 *  calendar day, never shifted by UTC parsing.  */
function dayOfWeekIso(iso: string): number {
  const p = iso.split('-').map(Number);
  if (p.length !== 3 || p.some(isNaN)) return 0;
  return new Date(p[0], p[1] - 1, p[2]).getDay();
}

/**
 * Convert the user's selected weekdays into the `selectedDayOffsets` form
 * the generator expects, anchored at a specific 7-day window's first day.
 *
 *   weekdays  – day-of-week indices the user picked (0=Sun..6=Sat).
 *               Order doesn't matter; duplicates are deduped.
 *   startIso  – YYYY-MM-DD of the window's first day. For ensureCurrentWeekPlan
 *               this is the row's week_start; for a brand-new plan it is today.
 *
 * Returns ascending offsets in [0, 6]. For Mon/Wed/Fri anchored to a
 * Sunday week_start the result is [1, 3, 5]. For the same picks anchored
 * to a Wednesday it becomes [0, 2, 5].
 *
 * If `weekdays` is null/empty after normalization, returns `null` — the
 * caller is expected to fall back to `pickDefaultDayOffsets(trainingDays)`.
 * That preserves existing-user behavior (training_weekdays = NULL) and the
 * 1/2/7-day code paths the spec leaves out of the picker.
 */
export function weekdaysToOffsets(
  weekdays: readonly number[] | null | undefined,
  startIso: string,
): number[] | null {
  const cleaned = normalizeTrainingWeekdays(weekdays);
  if (!cleaned) return null;
  const startDow = dayOfWeekIso(startIso);
  const offsets = cleaned.map(w => (w - startDow + 7) % 7);
  offsets.sort((a, b) => a - b);
  return offsets;
}

/** True when the picked weekdays include ≥ `runLen` consecutive days
 *  (treating the week as a cycle — Sat→Sun is consecutive). Used only by
 *  the onboarding/Profile soft-note about clustering for recovery; never
 *  blocks generation. Default threshold 3. */
export function hasConsecutiveRun(
  weekdays: readonly number[] | null | undefined,
  runLen = 3,
): boolean {
  const cleaned = normalizeTrainingWeekdays(weekdays);
  if (!cleaned || cleaned.length < runLen) return false;
  const set = new Set(cleaned);
  // Try each picked day as a possible run start; walk forward (mod 7).
  for (const start of cleaned) {
    let ok = true;
    for (let i = 0; i < runLen; i++) {
      if (!set.has((start + i) % 7)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
