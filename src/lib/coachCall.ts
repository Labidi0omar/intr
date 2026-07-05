// Coach's Call reliability helpers — pure, unit-tested.
//
// The "COACH'S CALL" prescription hero on the active exercise card in
// app/workout.tsx was suppressing intermittently. Three root causes were
// diagnosed (COACH_CALL_FIX.md); this module fixes them at the boundary
// between the DB fetch and the render decision:
//
//   A. Silent history-fetch failure left `lastWeights` empty for a whole
//      session, indistinguishable from "user has no history."
//   B. Swaps replaced the current exercise's name with one the fetch
//      never asked about, so `lastWeights[newName]` was undefined.
//   C. Exact-string name matching silently missed history when plan
//      and log rows differed by casing / trailing whitespace.
//
// Keeping this logic OUT of the React tree makes the decision testable
// (no harness, no mocks) and gives the hero one honest guard that
// distinguishes "actually cold-start" from "history not loaded yet."
//
// Product change (see PR description): the Coach's Call now renders on
// first-time exercises too. `historyLoad === 'ready'` is the signal we
// use to decide "we're SURE the user is a cold-starter" — while
// 'loading' or 'error' we still suppress so a cold message doesn't
// flash and then get replaced when history lands. Bodyweight
// suppression stays; it's the only INTENDED suppression left.

/**
 * Normalise an exercise name for use as a map key.
 *
 * Rules (kept as simple as possible so drift is easy to reason about):
 *   • trim leading / trailing whitespace
 *   • collapse internal whitespace runs to a single space
 *   • lowercase everything
 *
 * The result is used to key lastWeights / exerciseHistory / liftSessionTops
 * and to look them up at every read site. The query still sends the raw
 * plan names to Supabase — this app writes exercise_logs.exercise_name
 * from the same plan strings, so DB rows and the query match by
 * construction; the drift the app has actually seen is between
 * planDay.exercises[i].name and a swapped-in EXERCISES catalog entry that
 * differs by casing.
 *
 * null / undefined / non-string inputs collapse to '' so callers can pass
 * an optional name without a guard at every site.
 */
export function normalizeExName(name: string | null | undefined): string {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Load status for the initial per-exercise history fetch. Lives here
 *  because workout.tsx imports the type alongside the helpers; the
 *  retry/report logic that consumes it lives in fetchTodayPlan. */
export type HistoryLoadState = 'loading' | 'ready' | 'error';

export interface ShouldShowCoachCallInput {
  /** currentEx.equipment. 'bodyweight' (case-insensitive) suppresses. */
  equipment: string | null | undefined;
  /** Prescription for this exercise. `undefined` when the engine had no
   *  input to work with (no last weight in map). */
  rx: unknown | undefined;
  /** Prior-session weight for this exercise (kg). Falsy = no history. */
  lastKg: number | null | undefined;
  /** Where the initial history fetch is in its lifecycle. Used to
   *  distinguish "we're SURE this is a cold-start" (`'ready'`, no rx,
   *  no lastKg → show the cold-start hero) from "we don't know yet"
   *  (`'loading'` or `'error'` → suppress so a cold message doesn't
   *  flash and then get replaced by a real one when history lands). */
  historyLoad: HistoryLoadState;
}

/**
 * The render guard for the Coach's Call hero. Pure decision, tested
 * without a React harness.
 *
 *   true  → render the hero (caller builds it via buildPrescriptionHero).
 *   false → suppress. Falls through to the calibrating / coachHints line
 *           BELOW the hero in workout.tsx — deliberately not our concern.
 *
 * Decision table (top-down, first hit wins):
 *   • equipment is bodyweight → false   (only intended suppression left)
 *   • rx defined              → true    (engine has something to say)
 *   • lastKg > 0              → true    (history exists; presenter
 *                                        handles the copy variant)
 *   • historyLoad === 'ready' → true    (cold-start; caller renders the
 *                                        first-timer hero — a starting-
 *                                        load seed when available, or
 *                                        the bare calibration copy)
 *   • otherwise               → false   (loading / error — suppress so a
 *                                        cold message doesn't flash then
 *                                        get replaced when history lands)
 *
 * The 'loading' / 'error' branches are the intermittency-fix path — see
 * the retry + `workout:historyFetchEmpty` Sentry tag in workout.tsx's
 * fetchTodayPlan. Combined, the guard now honestly waits until the
 * history fetch has settled before choosing between "engine has a
 * prescription" and "first-timer, seed a starting weight."
 */
export function shouldShowCoachCall(input: ShouldShowCoachCallInput): boolean {
  const equipmentLc = (input.equipment ?? '').toLowerCase().trim();
  if (equipmentLc === 'bodyweight') return false;
  if (input.rx != null) return true;
  if (input.lastKg != null && input.lastKg > 0) return true;
  return input.historyLoad === 'ready';
}
