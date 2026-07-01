# Phase 1 separation — what's token plumbing vs what isn't

**Root cause:** there is no commit between the last "launch-prep" snapshot and now. The working tree already held large uncommitted feature WIP (a coach-voice system, a prescription presenter, a workout-abandon modal, a body-highlighter muscle view, dev-seed tooling, two new SQL migrations, edge-function edits, and a new dependency). Phase 1's token edits were applied **on top** of that dirty tree. Provenance is therefore proven by file nature, not by git baseline (the baseline doesn't exist).

## Bucket A — Pure Phase 1 token plumbing (in scope, low risk)
Diff is token swaps only. Safe to keep on a restyle branch.
- `src/theme/index.ts` (the new scales/tokens themselves)
- `CLAUDE.md` (doc fix)
- Presentation files whose diff is **only** `fontSize/borderRadius/color/shadow → token`: `coach.tsx`, `log-in.tsx`, `sign-up.tsx`, `welcome.tsx`, `progress.tsx`, `recovery.tsx`, `PillFilter.tsx`, `TabLayout.tsx`, `WeekStrip.tsx`, `ShareCard.tsx`, `_layout.tsx`
  - *Caveat:* classification is heuristic. Verify each diff by eye before trusting it — a couple (`history.tsx`, `journal.tsx`, `onboarding.tsx`) showed enough non-style changed lines that they may also carry feature WIP and belong in C.

## Bucket B — Pre-existing feature WIP, zero token content (cleanly separable)
No token reason to change. These predate Phase 1 and belong on their own feature branch, not entangled with a restyle.
- **New dependency:** `package.json`, `package-lock.json` (`react-native-body-highlighter`)
- **Coach system:** `coachVoice.ts`, `coachVoiceAI.ts`, `coachObservations.ts`, `coachRecap.ts` (+ their `.test.ts`)
- **Plan logic:** `planGeneration.ts`, `planSync.ts`, `planCatchUp.ts`, `planShift.ts` (+ tests), `gapDetection.test.ts`
- **Data/build:** `exercises.ts`, `buildInfo.ts`
- **Edge functions (explicitly out of scope per brief):** `supabase/functions/coach-recap/index.ts`, `supabase/functions/daily-reflection/index.ts`, `supabase/.temp/cli-latest`
- **All untracked new feature code:** `MuscleDetails.tsx`, `muscleInfo.ts`, `prescriptionPresenter.*`, `workoutAbandon.*`, `startingLoad.*`, `devSeed*.ts`, `devScenarios.*`, `coachHeroPin.*`, `coachTint.*`, `exerciseImage.*`, `trainingWeekdays.*`, `planCatchUp.weekdays.test.ts`, `Surface.tsx`, `CoachVoiceHero.tsx`, `app/dev-scenarios.tsx`
- **New migrations:** `20260620010000_training_weekdays.sql`, `20260623000000_profiles_cold_start_inputs.sql`

## Bucket C — ENTANGLED, not cleanly separable
Token edits **and** feature WIP live in the same uncommitted diff of the same file. With no pre-Phase-1 commit to diff against, the token-only slice is **unrecoverable by git** here.
- `app/workout.tsx` — 720 non-style changed lines (prescription presenter import, abandon-modal `BackHandler`/`useNavigation`, microLine logic rewrite) **+** ~150 token swaps, intermixed
- `app/(tabs)/home.tsx` — 512 non-style changed lines + token swaps
- `app/(tabs)/profile.tsx` — 243 non-style changed lines + token swaps
- Likely also: `onboarding.tsx` (310), `history.tsx` (85), `journal.tsx` (67)

## The honest bottom line
The brief's "fully reversible, one clean reviewable presentation diff" guarantee is **not retroactively recoverable** for Bucket C. You can't `git checkout` away the tokens without also losing the feature work, and vice versa, because they're the same uncommitted hunks.

## Most urgent risk (do this first, regardless of the restyle)
Hundreds of lines of feature work and ~30 new files are **uncommitted with no backup**. One bad `git checkout`, agent misfire, or `db reset` and it's gone. Commit it *now* as a labeled checkpoint before anything else.

## Recovery options
1. **Pragmatic (recommended):** commit the whole tree now as `wip: feature batch + phase1 tokens`. Tests pass (873/873), tsc clean. Accept that Phase 1 isn't isolated this once. Then enforce **commit-before-every-agent-pass** so future phases produce clean, reviewable, reversible diffs — restoring the guarantee prospectively.
2. **Partial isolation:** commit Bucket B to a `feature/coach-batch` branch and A+C to `restyle/phase1`. Reduces entanglement but C stays mixed, and the untracked files have interdependencies that make a clean cherry-pick fiddly. High effort, partial payoff.
3. **Full isolation:** not achievable. No baseline commit exists to reconstruct the token-only diff.

## Process fix going forward
Phase 2 and Phase 3 must each start from a **clean, committed** working tree. That's the only way the brief's per-phase "before/after, reversible, one screen per pass" discipline actually holds. The agent should refuse to run if `git status` isn't clean.
