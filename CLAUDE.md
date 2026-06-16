# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start            # Launch Expo dev server
npm run android      # Run on Android emulator/device
npm run ios          # Run on iOS simulator/device
npm run web          # Run in browser
npm run lint         # Run ESLint (expo/eslint-config)
npm run db:push      # Apply pending Supabase migrations to the linked project
npm run db:verify    # Replay the full migration chain on the local Docker DB (catches drift/errors before push)
```

There is no test suite configured. TypeScript strict mode is the primary correctness check — run `npx tsc --noEmit` to type-check without building.

## Stack

- **React Native 0.85 / Expo SDK 56** with New Architecture and React Compiler enabled
- **Expo Router** (file-based routing, typed routes) — `app/` directory is the entire navigation tree
- **Supabase** — Postgres + Auth + Edge Functions; client is a singleton at `src/lib/supabase.ts`
- **RevenueCat** — in-app subscriptions; entitlement checked via `useEntitlement()` hook in `src/lib/purchases.ts`
- **AsyncStorage** — local persistence for plan cache, notification time, user location preference

## Navigation Architecture

Root stack (`app/_layout.tsx`) contains two logical zones separated by auth state:

**Unauthenticated** (public): `/index` (session guard) → `/welcome` → `/sign-up` or `/log-in` → `/onboarding`

**Authenticated** (main app): `/(tabs)` with a custom `TabLayout` component that handles two levels of tabs:
- Top-level tabs: **Workout**, **Journal**, **Profile**
- Workout tab has three horizontally-scrollable sub-tabs rendered via a nested `TabLayout`: **Dashboard** (`home.tsx`), **Progress** (`progress.tsx`), **History** (`history.tsx`)

Modal-style screens `/plan` and `/workout` are pushed onto the root stack from within the tabs.

**Session guard flow**: `app/index.tsx` calls `supabase.auth.getSession()` on mount, then routes to `/(tabs)/home` (authenticated) or `/welcome` (not authenticated). The root layout also subscribes to `onAuthStateChange` to bounce signed-out users back to `/welcome`.

## Data Layer

All Supabase queries use RLS — every table filters on `auth.uid()`. The main tables:

| Table | Purpose |
|---|---|
| `profiles` | User metadata, split preference, training days, onboarding status |
| `workout_sessions` | Planned + completed workouts; `session_data` is a JSON blob. `energy_score` smallint (1–5, nullable, check-constrained) holds the raw pre-workout energy — written by `finishWorkout`; the lossy `energy_level` text bucket is kept for legacy reads |
| `exercise_logs` | Per-set records linked to a session |
| `weekly_plans` | AI-generated plan stored as `plan_data` JSON; also cached in AsyncStorage as `plan:current` |
| `journal_entries` | Daily reflections |
| `events` | Analytics (fire-and-forget via `src/lib/analytics.ts`) |

Edge Functions live in `supabase/functions/`: `daily-reflection` (nightly journal prompt) and `replan-today` (regenerates plan on app open if needed).

**Offline-first pattern**: The weekly plan is always read from AsyncStorage first; Supabase is the sync target, not the read source. `src/utils/gapDetection.ts` handles shifting the plan when the user returns after 3+ days.

**Training Status & tap-to-accept deload.** The dashboard's three primary cards are Consistency, Strength, and Training Status. Training Status ([src/lib/trainingStatus.ts](src/lib/trainingStatus.ts)) is a **pure, trend-based** read over the last ~2–3 weeks — per-lift strength deltas (from `computeStrengthTrendFromLogs().perLift`/`.topMover`), adherence, repeated low energy (`energy_score`/`energy_level === 'low'` across recent sessions), and repeated RIR misses — emitting 🟢 `recovering_well` / 🟡 `holding_steady` / 🔴 `backing_off` / `unknown`. **It is NOT the deleted readiness.ts**: there is no same-day input, so it can never penalize "trained today"; every fatigue trigger requires repetition (≥ 2). It feeds the existing 4-week deload (`blockWeek === 4`): `decideDeloadOffer` surfaces a **user-confirmed tap** to either pull a deload **early** (🔴 before week 4 → `applyDeloadToRows`) or **skip** a scheduled week-4 deload (strongly 🟢 → `clearDeloadFromRows`), both in [src/lib/planDeload.ts](src/lib/planDeload.ts) reusing `deloadSets`/`deloadReps`. Never automatic. Each accepted action rewrites only the active-week `weekly_plans` row (fire-and-forget, `reportSilent`, re-stamped `CURRENT_PLAN_VERSION`) and **survives `ensureCurrentWeekPlan`'s self-heal by construction** — the heal compares `(date, workoutType)` pairs only, and a deload changes neither, so it is not reverted; the change expires at the block boundary because only already-materialized rows are touched (same mechanism as exercise swaps).

**GapModal "resume" — catch-up pack from the canonical generator.** When the user picks "Pick up where I left off," `ackGap('resume')` in [app/(tabs)/home.tsx](app/(tabs)/home.tsx) computes a backlog N (count of unique past unfinished planned training dates across the last ~27 days of stored rows; the completions lookback covers the same window so old completed days never read as missed) and builds a fresh catch-up + future horizon via `buildCatchUpRows` ([src/utils/planCatchUp.ts](src/utils/planCatchUp.ts)). The first N sessions land on consecutive calendar days starting today (no rest between); after the backlog, normal cadence resumes.

Order comes from `generatePlan` — we never reorder stored PlanDays. The user's mesocycle position (count of completed non-recovery sessions) is passed as `dayIndexOffset` so PPL / upper_lower / full_body continue at the user's true next type (a missed legs day yields `legs → push`, not `legs → chest`). For bro_split the fixed weekly template restarts at chest by generator contract.

The resume cascade deletes every `weekly_plans` row from today onward and upserts the new catch-up rows, all stamped with `CURRENT_PLAN_VERSION`. Future rows pass `ensureCurrentWeekPlan`'s version-based `isSatisfied` check on the next call; the active-week row (back-to-back, not cadence-shaped) survives because the `gap:resolvedThrough` watermark covers it — see the self-heal below. (An earlier rigid-shift implementation pinned rows with `plan.shifted === true`; that marker handling was removed when the catch-up regen replaced it.)

**Active-week self-heal.** `ensureCurrentWeekPlan` treats the stored active-week row as a cache, not a source of truth. On every call it derives the canonical week via `deriveCanonicalWeek` ([src/utils/planCatchUp.ts](src/utils/planCatchUp.ts)) — `generatePlan` at the user's true rotation position (`dayIndexOffset` = count of completed non-recovery sessions with `planned_date` before the week's start, plus the existing block math) — and compares (date, workoutType) pairs only (exercise selection varies with planHistory and never triggers a rewrite). A deviating row (collapsed, wrong types, overlap artifact) is regenerated in place via upsert, so a corrupted account converges to a correct plan on next open with no manual row deletion. Exception: when `gap:resolvedThrough` ≥ the active week's start, the user just pressed resume/skip and the intentionally non-canonical catch-up row is trusted until the week rolls over. Counting completions *before the week* (not all-time) keeps the derivation stable across the week, making the heal idempotent.

Idempotent: backlog 0 ⇒ no-op. The legacy within-week `MissedModal` was removed alongside this rewrite — the GapModal now surfaces on every focus while an unresolved past training day exists, so there's only one mechanism.

**Exercise swaps are persisted into `weekly_plans` and expire at the block boundary.** When the user swaps an exercise (pre-screen or mid-session in [app/workout.tsx](app/workout.tsx) — `confirmPreScreenSwap` / `confirmSwap`), `persistSwapToPlan` writes the swap into every materialized `weekly_plans` row from today forward whose plan contains a day of the **same `workoutType`** (e.g. all upcoming "Legs" days), via the pure `applySwapToRows` ([src/lib/planSwap.ts](src/lib/planSwap.ts)). In each matching day it replaces the swapped-out exercise (matched by name, case-insensitive) with the swapped-in one — carrying that day's original `sets` (so a deload day keeps its reduced volume) and taking reps/restSeconds/equipment/imageUrl/primaryMuscle from the catalog entry. Days dated before today are skipped; a duplicate-guard leaves a day untouched if it already contains the replacement. The `plan:current` cache is updated for the row covering today. There is **no new table** — the swap lives in the existing plan JSON. The write is fire-and-forget (`reportSilent` on any failure) so a failed persist never breaks the workout. Because the next block's rows are generated later by `generatePlan` (which reselects exercises) and are never passed through `applySwapToRows`, the swap automatically does **not** carry into the next block — "until next block" scope falls out of only ever rewriting already-materialized rows. The swap survives the active-week self-heal by construction: the heal compares (date, workoutType) pairs only, and a swap changes neither, so a swapped row still reads as canonical and is not reverted; future rows stay satisfied because the upsert re-stamps `CURRENT_PLAN_VERSION`.

## Database migrations

The database is now managed via SQL migration files in `supabase/migrations/`. **Never hand-edit the schema in the Supabase dashboard.** Hand edits cause silent drift between prod and the migration history — we have already lost time to "missing column" 400s that no migration file explained.

**Rules for every schema change:**

1. Write a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_short_description.sql` (UTC timestamp).
2. Make it **idempotent** — use `create table if not exists`, `add column if not exists`, `create index if not exists`, `drop policy if exists` + `create policy`, `drop constraint if exists` + `add constraint`, `create or replace view`. The whole `supabase/migrations/` directory must be safely re-runnable end-to-end.
3. Run `npm run db:push` to apply it to the linked Supabase project **before** merging or shipping any app code that depends on the new column/table/policy. If the migration fails on push, fix the SQL — do not paste it into the dashboard as a workaround.
4. App code that depends on the new schema must not be released until `npm run db:push` has succeeded against prod.

### Migration history adoption — DONE (2026-06-07). Do not re-run.

The history baseline is **complete as of 2026-06-07**. All 13 local `supabase/migrations/` file versions are now recorded in prod's `supabase_migrations.schema_migrations`, so `db push` is a clean no-op and local ↔ prod agree. **Do NOT run `supabase migration repair` again** — re-running it would double-write history rows.

How it was done (for the record): the baseline was applied via the Supabase connector, not the CLI. All existing-schema files were recorded as applied without executing SQL; two genuinely-pending changes were actually run — `20260527020000_journal_entries.sql` (the `journal_entries` table was **missing in prod**, so journal writes had been silently failing to the AsyncStorage cache only) and `20260620000000_drop_daily_checkins.sql`. Security advisors after the change: no new errors (only the pre-existing leaked-password WARN).

Caveat for future readers: prod's `schema_migrations` also retains 5 older auto-numbered rows from earlier connector pushes (e.g. `20260604183118` carries the same SQL as local `exercise_logs_rir` at `20260530000000`). These are harmless duplicates-by-name; `db push` ignores remote-only versions. They can be deleted for a cosmetically clean `supabase migration list`, but it is not required.

### Safe deploy workflow

For any schema change, follow this order — skipping a step is how we got into the drift situation in the first place:

1. **Write the migration file** in `supabase/migrations/` following the idempotency rules above.
2. **Validate the full chain against a fresh DB.** Run `npm run db:verify` (which runs `supabase db reset --local` against the local Docker Supabase), or push to a throwaway branch project. Either path must build the entire migration chain from zero with no errors. If a later file depends on something an earlier file didn't create, you'll find out here instead of in prod.
3. **Push to prod**: `npm run db:push`. Only do this after step 2 is clean and after the one-time history adoption above has been done.
4. **Run the Supabase advisors** (Database → Advisors in the dashboard, or `mcp__b33f203f-…__get_advisors` via the MCP) and confirm no new ERROR-level findings on the Security or Performance tabs. If there are, treat them as part of this change — fix forward with another migration, do not patch by hand in the dashboard.

**Pre-deploy checklist** (run through this before every release that touches the data layer):

- [ ] All schema changes in this release exist as files in `supabase/migrations/` — no dashboard-only edits.
- [ ] `npm run db:push` runs clean (no pending migrations, no SQL errors) against the target project.
- [ ] `npx tsc --noEmit` passes — Supabase-generated types match the migrated schema.
- [ ] `npm test` passes.
- [ ] Smoke-tested against a real Supabase project (not just mocked tests) the writes that previously swallowed errors: weekly_plans upsert, profiles update, missed-shift upsert.

## Error reporting

Sentry is initialised in [app/_layout.tsx](app/_layout.tsx) at module load using `EXPO_PUBLIC_SENTRY_DSN`. When the env var is unset (local dev without the dashboard wired), `Sentry.init` is skipped entirely and every call no-ops cleanly — there is nothing to configure for local runs.

**To enable real error reporting**, set `EXPO_PUBLIC_SENTRY_DSN` in `.env` (and in the EAS build profile for release builds) to the project DSN from the Sentry dashboard. The DSN format is `https://<key>@<host>/<project_id>`.

**Use `reportSilent(error, tag, extra?)` from [src/lib/errorReporting.ts](src/lib/errorReporting.ts) for every silent catch.** The codebase deliberately swallows many errors (a Supabase read that fails shouldn't crash the screen, a cache write that fails shouldn't block the user) — but real bugs (RLS misconfig, missing columns, corrupt blobs) became invisible in prod. Every `catch { /* tolerated */ }` should call `reportSilent(e, 'file:method')` so the silent failure still surfaces in Sentry without changing user-facing behavior. The `tag` becomes a searchable Sentry tag — keep it short and stable (`'home:fetchProfile'`, `'workout:loadHistory'`).

A dev-only Sentry smoke test is wired to a long-press on the home-screen greeting (`app/(tabs)/home.tsx`, gated on `__DEV__`). Throws a labeled error through `reportSilent` so you can confirm events arrive in the dashboard after first setting the DSN. Release builds never expose this trigger.

## Theme & Styling

The theme is defined once in `src/theme/index.ts` and frozen (`Object.freeze`). Never mutate it. Access it via the exported `theme` object — there is no theme hook or context, just a direct import.

- Fonts: **Syne Bold** (headings), **DM Sans** (body) — loaded in `app/_layout.tsx`
- Palette: Obsidian dark only (`#070708` bg), with semantic accents: teal (primary), coral (streaks), amber (PRs), red (destructive)
- All spacing, radii, and animation durations come from `theme.layout` and `theme.animation`

## Key Architectural Patterns

**Split assignment**: `profiles.preferred_split` is derived from training days count (1→`full_body`, 2→`upper_lower`, 3-4→`ppl`, 5-7→`bro_split`). This is set during onboarding and can change if the user edits their schedule.

**Analytics**: `track(event, props)` in `src/lib/analytics.ts` is fire-and-forget — it inserts into the `events` table and never throws. Call it freely; it won't block the UI or surface errors.

**Exercise catalog**: 100+ exercises in `src/constants/exercises.ts`, each with `equipment`, `primaryMuscle`, `location` (gym/home), `difficulty`, and default `sets`/`reps`/`restSeconds`. Plan generation and workout screens pull directly from this array.

**Muscle group normalization**: `src/utils/muscleGroups.ts` maps fine-grained muscle names (e.g., `"biceps"`, `"lats"`) to five UI filter buckets: `CHEST`, `BACK`, `SHOULDERS`, `ARMS`, `LEGS`.

**Context**: Two React contexts exist — `ThemeContext` (provides the frozen theme object) and `TabScrollContext` (coordinates scroll lock/unlock between nested ScrollViews in the tab layout). Both are provided at the root layout level.

## Path Alias

`@/` maps to the project root. Use `@/src/...` for src imports, `@/app/...` for route references.
