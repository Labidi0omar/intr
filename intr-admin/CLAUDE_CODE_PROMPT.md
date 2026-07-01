# Claude Code prompt — fix the intr-admin dashboard

Paste everything below the line into Claude Code, run from the `intr-admin/` repo root.

---

You are working in the `intr-admin` repo: a Vite + React + TypeScript + Tailwind + Supabase
admin dashboard for the Liftr fitness app. It is deployed to **public GitHub Pages**
(`npm run deploy` → `gh-pages -d dist`, `vite.config.ts` has `base: '/intr-admin/'`).

The Supabase project ref is `ehbbpawgntvykkiioukl`. RLS is ENABLED on every table.
Real tables/columns:
- `profiles`: id, username, fitness_level, goal, preferred_split, onboarding_complete, created_at, training_days
- `workout_sessions`: id, user_id, planned_date, completed_at, workout_type, location, energy_level, completed, exercises_done, created_at, replanned, is_recovery
- `journal_entries`: user_id, date, user_text, ai_response, created_at, updated_at
- `events`: id, user_id, event_name, properties, created_at
- also exist: weekly_plans, progress_logs, exercise_logs, exercises, replan_calls

## Non-negotiable goal
This is a static site on public GitHub Pages. **No secret may ever exist in the client
bundle.** Therefore the service-role key must be removed completely and admin access must
be granted through Supabase RLS, not by bypassing it.

## Tasks

### 1. Kill the service-role architecture (CRITICAL SECURITY)
- In `src/utils/supabaseClient.ts`: delete `adminDb` and every reference to
  `VITE_SUPABASE_SERVICE_ROLE_KEY`. Export a single `supabase` client built from the
  URL + anon key only. (The anon key is public by design; keep it.)
- Delete the `VITE_SUPABASE_SERVICE_ROLE_KEY` line from `.env.local` and update the
  comments so nobody re-adds it. Confirm no `VITE_*` secret remains anywhere.
- Update every page that imported `adminDb` to use `supabase` instead
  (currently `src/pages/OverviewPage.tsx`).

### 2. Add a real admin role enforced in the database
- Add an `is_admin boolean default false` column to `profiles` (write a SQL migration).
- Create a SQL helper `public.is_admin()` that returns whether `auth.uid()` maps to a
  profile with `is_admin = true`.
- For each table the dashboard reads (`profiles`, `workout_sessions`, `journal_entries`,
  `events`, and any others you wire up), add an RLS **SELECT** policy:
  `using ( is_admin() )` — so an authenticated admin can read all rows, while normal
  users keep their existing own-row policies. Admins get READ ONLY here; do not add
  admin write/delete policies.
- Provide the migration SQL in `supabase/migrations/` and also print it so I can review
  before applying. Do not apply destructive changes without showing me first.
- Set `is_admin = true` for my admin account (ask me for the email/uid; do not hardcode
  `test@gmail.com`).

### 3. Make the auth gate real
- `src/components/AuthGuard.tsx`: stop comparing against a hardcoded email string.
  After login, fetch the caller's own `profiles` row via `supabase` and gate on
  `is_admin === true`. Non-admins get the existing "access denied" screen.
- This is defense-in-depth only — the real enforcement is the RLS policies from step 2.

### 4. Replace mock data with real queries
The following pages currently render `src/data/mockData.ts` instead of real data. Rewrite
each to query Supabase via the anon client (now RLS-authorized for admins). Keep the exact
same visual layout/components; only swap the data source. Show loading and empty states.
- `src/pages/UserAnalyticsPage.tsx` — real counts from `profiles`; split/goal distributions
  from `profiles.preferred_split` / `profiles.goal`; roster from `profiles`; retention from
  `workout_sessions` cohorts.
- `src/pages/ContentWorkoutPage.tsx` — real stats from `workout_sessions` / `exercise_logs`.
- `src/pages/SubscriptionRevenuePage.tsx` — derive from `events`
  (`subscription_started`, `paywall_shown`). Clearly label these as ESTIMATES in the UI,
  since there is no real billing table.
- `src/pages/SystemHealthPage.tsx` — if there is no real log source, label the panel
  "Sample / Illustrative" instead of presenting fake logs as live telemetry.
- After migration, delete any now-unused exports from `mockData.ts`.

### 5. Fix the GitHub Pages base-path bug
- Asset references like `src="/logo.jpg"` will 404 under `base: '/intr-admin/'`.
  Use `import.meta.env.BASE_URL` (or relative paths / imported assets) for `public/`
  assets such as the login logo in `AuthGuard.tsx`.

### 6. Verify
- `npm run build` must pass with no TypeScript errors.
- Run `npm run lint`.
- Build the bundle and grep `dist/` to PROVE no service-role JWT and no `VITE_` secret is
  present: e.g. confirm the only Supabase key in `dist/` is the anon key.
- Manually sanity-check that an admin session loads real numbers and a non-admin session
  is denied.

## Order of work
1, 2, 3 first (security), then 4, then 5, then 6. Show me the SQL migration before applying
it. Don't invent columns — only use the schema listed above; if you need a column that
doesn't exist, ask.
