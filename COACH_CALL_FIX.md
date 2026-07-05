# Coach's Call — "sometimes missing" — diagnosis + fix

**Not caused by the restyle or the Phase 2 preview.** The preview is isolated (no production file imports it). The Coach's Call ("COACH'S CALL" prescription hero on the active exercise card in `app/workout.tsx`, ~line 2652) lives in the pre-existing coach/prescription WIP. It renders only when the current lift has a prescription or a last weight, and three separate mechanisms make that intermittent.

## Root causes (confirmed in code)

### A. Silent history-fetch failure → suppressed all session (the "random" one)
`lastWeights` is `useState({})` (line 257), populated by an async `exercise_logs` query (lines 611-669).
- If the query **throws**, `catch → reportSilent` (line 666-668) and `lastWeights` stays `{}`.
- If it returns **null** (error without throwing), the `if (logs)` guard (line 623) skips `setLastWeights`, same result.
- With `lastWeights === {}`, `prescriptions` is empty and the hero's guard `if (!rx && !lastKg) return null` (line 2670) fires for **every** exercise.

Result: on a slow, offline, or errored fetch, the Coach's Call is gone for the whole session with no visible signal. Network-dependent → looks random.

### B. Swap keying gap → gone for swapped-in lifts
The fetch keys on `todayPlan.exercises` names (line 612). After a pre-screen or mid-session swap, `currentEx.name` becomes the swapped-in exercise, which was never in that fetch list, so `lastWeights[swappedName]` is undefined and the hero suppresses — even if the user has history for that lift under a different plan.

### C. Exact-string name matching → silent misses
`.in('exercise_name', exerciseNames)` (line 620) and every `lastWeights[ex.name]` / `currentEx.name` lookup are case- and whitespace-sensitive. Any drift between plan names and logged `exercise_name` misses silently.

## The distinction that matters
Two suppression cases are **correct and must stay**: bodyweight lifts (line 2666) and genuine cold-start lifts with no history. The bug is that "history exists but didn't load / didn't match" is currently indistinguishable from "no history" — the UI treats a failed fetch the same as a first-timer.

---

# Claude Code prompt — fix Coach's Call reliability

> Run from a clean tree (commit first). Scope is the Coach's Call reliability only — do NOT rewrite the coach feature, do NOT touch the restyle/preview.

You are fixing an intermittent bug: the "COACH'S CALL" prescription hero in `app/workout.tsx` sometimes doesn't render. Root causes are diagnosed in `COACH_CALL_FIX.md` (A: silent history-fetch failure leaves `lastWeights` empty; B: swaps key on an exercise name never fetched; C: exact-string name matching). Fix all three, minimally and testably. Preserve the two intended suppressions (bodyweight, true cold-start).

## Constraints
- Presentation of the hero must not change visually. This is a data/timing correctness fix.
- No new dependencies. Keep the existing Supabase query shape.
- Every silent catch keeps `reportSilent`, but must no longer leave the user in a state indistinguishable from "no history."

## Fixes
1. **Distinguish loading/failed from empty.** Add an explicit load state for the history fetch (e.g. `historyLoad: 'loading' | 'ready' | 'error'`). While `loading`, the hero should not render its final "no data" suppression as if cold-start; when `error`, retry the fetch once, and if it still fails, log a distinct tag (`workout:historyFetchEmpty`) so it's visible in Sentry instead of blending into normal cold-start.
2. **Normalize names** (case-insensitive + trim) consistently: when building `exerciseNames` for the query, when keying `lastWeights`/`exerciseHistory`/`liftSessionTops`, and at every read site (`prescriptions`, the hero at ~2670, coachHints). Introduce one `normalizeExName()` helper and route all keys through it. This fixes C and hardens B.
3. **Cover swaps.** When a swap sets a new `currentEx.name` that has no `lastWeights` entry, fetch that single exercise's history on demand (same query, one name) and merge into `lastWeights`, so the hero recovers instead of vanishing. Fire-and-forget with `reportSilent` on failure.

## Tests (add, don't skip)
- Unit: `normalizeExName` collapses casing/whitespace.
- A test around the hero's render decision (extract the guard into a pure helper like `shouldShowCoachCall({ equipment, rx, lastKg, historyLoad })` if it isn't already) asserting: bodyweight → false; cold-start ready → false; history loading → not treated as cold-start; rx present → true; swapped-in name after merge → true.
- Run `npx tsc --noEmit` and `npm test` — both green before reporting.

## Report
- Files touched, the extracted helper(s), and the new test cases.
- Confirm the two intended suppressions still hold and the hero is visually unchanged.
