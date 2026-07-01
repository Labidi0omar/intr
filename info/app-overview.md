# Intr — App Overview

*Single source of truth for the app's state. Last updated 2026-06-07.*

---

## 1. What it is

A React Native / Expo **hypertrophy training app** built around **autoregulation** — it adapts your training load to your real readiness (reps-in-reserve + energy), not a fixed percentage. Core loop: it generates a mesocycle plan, you log sets + how hard they felt (RIR), and a deterministic engine prescribes next session's load. A coaching layer narrates the decisions and (planned) understands the whole person.

**Identity:** obsidian dark, mechanical, athletic, data-dense. Architectural principle: **deterministic facts + AI voice** — math decides load; AI only phrases. A gym app for serious lifters, not a wellness/yoga app.

**Status:** pre-launch. Every account in the DB is a dev/test account — no real users yet.

---

## 2. Stack

- **React Native 0.85 / Expo SDK 56**, New Architecture + React Compiler enabled.
- **Expo Router** — file-based routing; `app/` is the nav tree.
- **Supabase** — Postgres + Auth + Edge Functions. Project: `intr`, id `ehbbpawgntvykkiioukl`, region eu-west-1, Postgres 17.
- **RevenueCat** — subscriptions; entitlement via `useEntitlement()` (`src/lib/purchases.ts`).
- **AsyncStorage** — local cache (plan, coach messages, pending saves, journal, notification time, location).
- **Sentry** — error reporting (`@sentry/react-native`), live (DSN set).
- **No test runner originally; jest now in use** — 266 tests passing. `npx tsc --noEmit` clean except 2 known baseline `fontVariantNumeric` type errors (pre-existing, harmless).

---

## 3. Navigation

- Top tabs: **Workout**, **Journal**, **Profile**.
- Workout has horizontal sub-tabs: **Dashboard** (`home.tsx`), **Progress** (`progress.tsx`), **History** (`history.tsx`).
- Modal/pushed screens: `/workout`, `/plan`, `/recovery`.
- Auth flow: `/index` (session guard) → `/welcome` → `/sign-up` or `/log-in` → `/onboarding`.

---

## 4. Data layer (Supabase)

All tables use RLS (own-rows-only), standardized this session with explicit `WITH CHECK` and `(select auth.uid())`.

| Table | Purpose | Notes |
|---|---|---|
| `profiles` | user meta, split, training_days, fitness_level, onboarding | FK id → auth.users CASCADE |
| `weekly_plans` | AI/generated plan JSON per 7-day window | has `plan_version` (added this session); unique (user_id, week_start) |
| `workout_sessions` | planned + completed workouts | has `is_recovery` (added); FK user_id → profiles CASCADE |
| `exercise_logs` | per-set records (weight, reps_in_reserve) | `reps_in_reserve` + `is_recovery` added; FKs now CASCADE |
| `progress_logs` | bodyweight log | |
| `journal_entries` | daily free-text journal + AI reflection | |
| `events` | analytics (fire-and-forget) | |
| `replan_calls` | replanner usage | |
| `exercises` | 100+ exercise catalog (`src/constants/exercises.ts`) | public read |

**Migration state (BASELINED 2026-06-07):** prod was hand-built in the dashboard; earlier schema fixes were applied directly to prod via the Supabase connector. As of 2026-06-07 the history is **baselined** — all 13 local `supabase/migrations/` file versions are recorded in `supabase_migrations.schema_migrations`, so local ↔ prod now agree and `db push` is a clean no-op. Two genuinely-pending changes were applied during the baseline: `journal_entries` (the table was MISSING in prod — journal writes had been silently failing to AsyncStorage only; now created with RLS) and the `daily_checkins` drop. **Do NOT re-run any `supabase migration repair` baseline command — it is done.** Note: prod's `schema_migrations` also still holds 5 older auto-numbered rows (e.g. `20260604183118` = the same SQL as local `exercise_logs_rir`) — harmless duplicates by name; `db push` ignores remote-only versions. Future schema changes follow the normal write-file → `db:verify` → `db:push` flow.

**Edge Functions** (`supabase/functions/`):
- `daily-reflection` — **deployed (v5)**, powers the journal AI reflection.
- `replan-today` — **deployed (v3)**; note: deployed version predates the `is_recovery` filter in the repo (harmless — no recovery sessions feed it yet).
- `delete-account` — **deployed (v1) this session**; service-role deletion of the caller's auth user → cascades all data.
- `coach-recap` — **NOT deployed**. The coach card falls back to deterministic text. Needs deploy + `ANTHROPIC_API_KEY` for AI recaps.

---

## 5. Key systems & where they live

- **Plan generation** — `src/lib/planGeneration.ts`. Mesocycle: exercises held for a **4-week block** (deterministic seeded selection), week 4 is a **deload** (reduced volume, labeled). `CURRENT_PLAN_VERSION` (currently 4) bumps force regen of future rows. `generatePlan` is pure. Splits: full_body(1)/upper_lower(2)/ppl(3-4)/bro_split(5-7).
- **Plan sync** — `src/lib/planSync.ts`. `ensureCurrentWeekPlan` keeps ~4 weeks ahead, regenerates rows below current version, leaves the active week intact. Self-heals null `training_days` from preferred_split.
- **Load prescription (autoregulation)** — `src/lib/loadPrescription.ts`. Pure RIR→load engine; energy ≤2 pulls load down only. Deno mirror in `supabase/functions/_shared/`.
- **Coach lines (deterministic)** — `src/lib/coachHints.ts`. Per-set hints + `buildReadinessNarration` (Stage 1).
- **Coach messages store** — `src/lib/coachMessages.ts`. AsyncStorage, kinds `recap`/`autoreg`, `appendCoachMessageOnce` (idempotent by key). Feeds the dashboard coach card.
- **Coach recap (AI)** — `src/lib/coachRecap.ts` + `supabase/functions/coach-recap`. Salience hierarchy + always-renders deterministic fallback. Function NOT deployed.
- **Recovery** — `src/constants/recoveryExercises.ts`, `src/lib/recovery.ts` (exclusion boundary), generator + `app/recovery.tsx`. Rest-day "Active recovery" session; logged `is_recovery=true` → counts streak, excluded from coach/PR/progression.
- **Durable save** — `src/lib/pendingSync.ts`. Save-first ordering, retry, queue-on-failure. (Offline path deferred — see below.)
- **Error reporting** — `src/lib/errorReporting.ts` `reportSilent()`, routed to Sentry.
- **Build tag** — `src/constants/buildInfo.ts` `BUILD_TAG` (currently `b5`). Shows on Profile + Metro log; the instrument for catching stale bundles.

---

## 6. What's WORKING (verified this session)

- Plan generation: 4-week blocks hold the same exercises, week 4 deloads (verified in DB).
- Bro-split rotation fixed (stable weekly template, no drift).
- Stuck "building your week" bug fixed (was missing DB columns + idempotent regen skipping new logic).
- Old accounts unstuck (null training_days backfilled + self-heal).
- DB security hardened + verified (cross-user writes blocked, analytics view locked down).
- Online workout save works (verified — multiple accounts saving).
- RIR logging redesign: chips are the commit, color-coded at rest.
- "Last used X kg" on the exercise screen.
- Recovery session (rest-day "Active recovery") generates + saves as is_recovery.
- Coach Stage 1: readiness narration on workout pre-screen + coach card.
- delete-account: deployed; cascade FKs fixed so it wipes everything (needs final throwaway-account test).
- Error reporting (Sentry) live; ~30 silent catches now report.
- Build-tag instrument working (`b5`).

---

## 7. What's NOT working / incomplete / risky

- **Offline support — DEFERRED, not working.** Finishing offline doesn't queue/replay (root: `auth.getUser()` etc. throw before save; dashboard reads plan from network not cache → blank offline). Online saves are fine. To do offline RIGHT: cache-first reads + working write queue, as one feature. (To-Do #21.)
- **`coach-recap` not deployed** → coach card uses deterministic fallback only. AI recap needs deploy + `ANTHROPIC_API_KEY`.
- **`daily_checkins` dead-table cleanup — DONE** (this session). All six reads (workout/home/journal/gapDetection/replanner/deload-nudge) are repointed to `workout_sessions.energy_level` (mapped `low→2 / normal→3 / high→4`); the deload-count path and the home-screen deload banner were deleted (week-4 deload is already deterministic in plan generation); the table is dropped in `supabase/migrations/20260620000000_drop_daily_checkins.sql` (not yet pushed — pending the one-time history baseline). **Semantics changed:** `detectReturnGap` now means *days since last completed workout* (rest days don't reset the gap); journal AI no longer receives a `mood_tag`; dashboard history rows no longer carry a `reflection_snippet`.
- **Coach feels thin / copy is weak** — deterministic lines are placeholder-quality; a dedicated voice pass is queued (#40).
- **Migration drift** — prod schema changed via connector; repo files not baselined. `db push` unsafe until #27.
- **Coach Stages 2 & 3 not built** (journal-aware AI) — gated on coach-recap deploy + API key + a distress classifier.
- **Recovery menu refinement pending** — the rest-day recovery is currently an auto-composed session; the "pick a category" menu (Core/Forearms/Calves/Cardio/Mobility) prompt is written but not yet built (would bump BUILD_TAG to b6).
- **Offline-queue analytics gap** — queued workouts (if offline worked) wouldn't fire `workout_completed`, under-counting metrics.
- **Two baseline TS errors** (`fontVariantNumeric` in profile.tsx + workout.tsx) — pre-existing, harmless, never fixed.

---

## 8. The Coach system — staged plan

The coach should feel present via **memory/continuity + whole-person awareness + adaptation** (research-backed; see `docs/coach-and-journal-strategy.md`).

- **Stage 1 — deterministic autoregulation narration.** DONE. "Energy's low — keeping loads conservative today." Shown on pre-screen + coach card. No AI.
- **Next (unblocked): deterministic message-type expansion** — briefings (training-day), deload notices, PR/milestones, streaks → feed the coach card so it's present across the week. No AI/key needed. *This is the current intended next build.*
- **Stage 2 — local distress + sentiment classifier** (gates journal use; safety router). GATED on #29.
- **Stage 3 — journal-aware AI coaching** (coach references energy + journal, adapts, narrates). GATED on #29 + API key + Stage 2 + a transparency notice + a **locale-aware crisis resource** (never hardcode one country; use a maintained directory resolved by device locale).
- **Path A — Coach Hub** (browsable dated history screen) — after the message types exist.

---

## 9. To-Do list (current)

**Done this session:** stuck-plan fix; bro-split blocks + deload; DB security hardening; error observability (Sentry); RIR redesign + recovery data model; coach recap → dashboard card; self-heal accounts + rest-day path; Stage 1 narration; recovery generator + screen; delete-account (deployed); build-tag instrument.

**Launch blockers / important:**
- **#28 delete-account** — deployed; needs throwaway-account test + DB-verify the wipe. (in progress)
- **#27 migration baseline** — `supabase migration repair` → `db:verify` → `db:push`; stops the recurring schema drift.
- **#31 leaked-password protection** — one Auth dashboard toggle (last security-advisor item).
- **#29 deploy coach-recap + set ANTHROPIC_API_KEY** — unblocks AI coach / Stages 2-3.
- **#30 Sentry DSN** — effectively done; long-press greeting to confirm an event lands.
- **#26 device verification** — Stage1/RIR/deload/blocks verified; remaining: coach card, last-used line, Progress/Profile populate, recovery flow on a real device.

**Coach track:**
- Deterministic coach message types (briefing/deload/PR/streak) — next build.
- Recovery category menu (Core/Forearms/Calves/Cardio/Mobility) — prompt written, not built.
- #37 journal-aware coach (Stages 2/3) — gated.

**Features / polish:**
- #34 planner exercise_overrides table (PR2); #35 swap-exercise UI (PR3).
- #36 offline-queue analytics gap.
- #38 6-day bro split: don't double Arms (change `dropOrder`).
- #40 UI/UX polish pass + coach-voice copy pass.
- #21 full offline support (deferred — do completely or not at all).

---

## 10. Ops / deploy notes

- **Build:** JS-only changes need only a Metro reload (`npx expo start --dev-client --clear`) — no native rebuild (no native deps added this session). Confirm fresh code via `BUILD_TAG` on Profile / `[build] bX` in Metro.
- **DB:** `npm run db:push` (prod), `npm run db:verify` (local replay). **Run the one-time `supabase migration repair --status applied …` baseline before any push** (prod predates the migration files).
- **Edge functions:** `supabase functions deploy <name>`. Secrets needed: `ANTHROPIC_API_KEY` (coach-recap), service-role key is auto-injected.
- **Env:** `EXPO_PUBLIC_SENTRY_DSN` (set), `ANTHROPIC_API_KEY` (needed for coach-recap).
- **Diagnosis:** the Supabase connector (Postgres/API/edge logs + SQL) is the fastest way to find real failures — used repeatedly this session to catch column-drift and the offline-save bug instead of guessing.

---

## 11. Hard-won lessons (read before changing things)

1. **Never ship app code ahead of the schema.** Four times this session a feature broke because code queried a column the migration never pushed. Apply the migration first.
2. **Tests passing ≠ works on device.** The original bug and the offline-save bug both passed tests. Verify on a real device; use the build tag to confirm you're testing fresh code.
3. **Don't swallow errors silently.** Silent `catch {}` hid bugs for multiple sessions. Route to Sentry via `reportSilent`.
4. **Deterministic facts + AI voice.** Keep math/logic deterministic and testable; let AI only phrase. Cheaper, safer, on-brand.

---

## 12. Full feature & file inventory (added after repo audit)

> Sections 1–11 were written from this session's work and under-covered areas we never touched. This is the complete inventory. Items marked **(file-confirmed)** exist but weren't deep-read this session — treat their internals as "present, not audited."

### Screens (`app/`)
- `index.tsx` — session guard → routes to home or welcome.
- `welcome.tsx`, `sign-up.tsx`, `log-in.tsx` — auth (Supabase email/password + Google OAuth).
- `onboarding.tsx` — sets fitness_level, training_days, location; writes profile; triggers first plan generation.
- `(tabs)/_layout.tsx` + `(tabs)/index.tsx` — custom two-level TabLayout, pager-view sub-tabs.
- `(tabs)/home.tsx` — Dashboard: today card, week strip, streak/effort/trend stats, coach card, gap + missed modals, month modal, recovery entry.
- `(tabs)/progress.tsx` — progress / bodyweight / strength views. **(file-confirmed)**
- `(tabs)/history.tsx` — past sessions list. **(file-confirmed)**
- `(tabs)/journal.tsx` — daily free-text journal + AI reflection.
- `(tabs)/profile.tsx` — settings, goal/split, notification time, logout, delete-account, build tag.
- `workout.tsx` — live workout: set logging, RIR chips, prescriptions, ad-hoc start, finish/durable save, coach-recap trigger.
- `recovery.tsx` — rest-day active-recovery session.
- **Correction:** there is **no `plan.tsx`** — Section 3's `/plan` reference was wrong. Plan generation lives in `planSync`/`planGeneration`, surfaced via the dashboard + month modal.

### Auth & identity
- Supabase email/password + **Google sign-in** (`src/lib/googleAuth.ts`, expo-web-browser/expo-linking OAuth redirect). **(file-confirmed)**

### Monetization — NOT documented before
- **RevenueCat** via `react-native-purchases` + `src/lib/purchases.ts` (`useEntitlement()`, `isPro`). Paywall/entitlement gating exists. **What's actually gated isn't audited — verify before launch** (and confirm the offline fail-open behavior so paying users aren't locked out).

### Notifications — NOT documented before
- `src/utils/notifications.ts` + expo-notifications: daily workout reminder (time in AsyncStorage), comeback nudge after a gap, permission handling. **(file-confirmed)** — habit-loop critical; verify they actually fire on device.

### Home-screen widget — NOT documented before
- `src/lib/widgetBridge.ts` (`setWidgetData`) stages today's workout type for a native home-screen widget. **(file-confirmed)**

### Social share — NOT documented before
- `src/components/ShareCard.tsx` + react-native-view-shot + react-native-share + expo-sharing: shareable image of a completed session / PR. **(file-confirmed)**

### AI replanner — NOT documented before
- `supabase/functions/replan-today` (deployed v3) + `src/lib/replanner.ts`: regenerates today's plan when readiness is low / on return after a gap; reads journal + energy as context; clamps load to the deterministic prescription. `replan_calls` logs usage.

### Plan adaptation when life happens — NOT documented before
- `src/utils/gapDetection.ts` + `src/utils/planShift.ts`: detects return gaps (3+ days), detects missed planned days, shifts the plan forward. Drives the GapModal + MissedModal on the dashboard.

### Progress, streak & calendar — under-documented before
- `src/utils/streak.ts` — streak from completed sessions (recovery counts; per recovery.ts rules).
- `src/utils/dashboardStats.ts` — effort zone (% sets in RIR target) + strength trend (recent weight delta).
- `src/utils/monthCalendar.ts` — 30-day forward plan view (month modal).
- `src/components/WeekStrip.tsx` — week dots.

### Ad-hoc workouts — NOT documented before
- `generateAdHocDay` in `planGeneration.ts` (+ adhoc test): one-off Push/Pull/Legs/Upper/Lower/Full-Body for the no-plan card. (Rest-day now routes to recovery instead.)

### Recovery — confirmed built
- `src/lib/recoveryGeneration.ts` (generator, #32 — **built**), `src/constants/recoveryExercises.ts`, `src/lib/recovery.ts` (exclusion boundary), `app/recovery.tsx`. Category-menu refinement (Core/Forearms/Calves/Cardio/Mobility) still pending (b6 prompt written, not run).

### Theme, components, contexts
- `src/theme/index.ts` — frozen obsidian theme (accentTeal/Coral/Amber/Red + accentPositive green). Syne (headings) / DM Sans (body).
- Components: Button, Input, EmptyState, WeekStrip, TabLayout, PillFilter, ShareCard.
- Contexts: ThemeContext, TabScrollContext. `src/utils/muscleGroups.ts` normalizes muscle names to 5 UI buckets.

### OTA / updates — the session-1 ghost
- `expo-updates` installed but **OTA is disabled** in the native build (the source of the original "rebuilds don't take" confusion). JS reaches the device via Metro/dev-client reload or a fresh build, not OTA.

### Other native deps
- expo-haptics, react-native-pager-view (sub-tab swipe), @react-native-community/slider, react-native-svg (graphics), expo-image, react-native-reanimated/worklets.

### Test suite
- jest + ts-jest (`src/**/*.test.ts`), ~266 tests. Suites: planGeneration (rotation/anchor/mesocycle/deload/adhoc), planSync, loadPrescription (+parity), recovery, recoveryGeneration, coachHints, coachMessages, coachRecap, pendingSync, deleteAccount, dashboardStats, gapDetection, widgetBridge.

### Biggest "verify before launch" unknowns surfaced by this audit
- **Paywall/RevenueCat:** what's gated, and does entitlement fail *open* offline?
- **Notifications:** do the daily reminder + comeback nudge actually fire on device?
- **Widget + ShareCard:** untested this session; both are user-facing.
- **Google sign-in:** OAuth redirect untested this session.
- **progress / history screens:** never opened — confirm they render real data (history was confirmed working earlier; progress only partially).
