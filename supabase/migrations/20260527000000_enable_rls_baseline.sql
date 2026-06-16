-- Baseline RLS policies for the six app tables.
-- Idempotent: safe to re-run. Each statement re-creates its policy.
--
-- Threat model: the public anon JWT is embedded in the mobile client
-- (src/lib/supabase.ts). Without RLS, anyone in possession of the key
-- can read/write every user's rows. These policies restrict every row
-- to the auth.uid() that owns it.

-- ─── profiles ──────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ─── daily_checkins ────────────────────────────────────────────────────
alter table public.daily_checkins enable row level security;

drop policy if exists "daily_checkins_select_own" on public.daily_checkins;
create policy "daily_checkins_select_own" on public.daily_checkins
  for select using (auth.uid() = user_id);

drop policy if exists "daily_checkins_insert_own" on public.daily_checkins;
create policy "daily_checkins_insert_own" on public.daily_checkins
  for insert with check (auth.uid() = user_id);

drop policy if exists "daily_checkins_update_own" on public.daily_checkins;
create policy "daily_checkins_update_own" on public.daily_checkins
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "daily_checkins_delete_own" on public.daily_checkins;
create policy "daily_checkins_delete_own" on public.daily_checkins
  for delete using (auth.uid() = user_id);

-- ─── weekly_plans ──────────────────────────────────────────────────────
alter table public.weekly_plans enable row level security;

drop policy if exists "weekly_plans_select_own" on public.weekly_plans;
create policy "weekly_plans_select_own" on public.weekly_plans
  for select using (auth.uid() = user_id);

drop policy if exists "weekly_plans_insert_own" on public.weekly_plans;
create policy "weekly_plans_insert_own" on public.weekly_plans
  for insert with check (auth.uid() = user_id);

drop policy if exists "weekly_plans_update_own" on public.weekly_plans;
create policy "weekly_plans_update_own" on public.weekly_plans
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "weekly_plans_delete_own" on public.weekly_plans;
create policy "weekly_plans_delete_own" on public.weekly_plans
  for delete using (auth.uid() = user_id);

-- ─── workout_sessions ──────────────────────────────────────────────────
alter table public.workout_sessions enable row level security;

drop policy if exists "workout_sessions_select_own" on public.workout_sessions;
create policy "workout_sessions_select_own" on public.workout_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "workout_sessions_insert_own" on public.workout_sessions;
create policy "workout_sessions_insert_own" on public.workout_sessions
  for insert with check (auth.uid() = user_id);

drop policy if exists "workout_sessions_update_own" on public.workout_sessions;
create policy "workout_sessions_update_own" on public.workout_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "workout_sessions_delete_own" on public.workout_sessions;
create policy "workout_sessions_delete_own" on public.workout_sessions
  for delete using (auth.uid() = user_id);

-- ─── exercise_logs ─────────────────────────────────────────────────────
alter table public.exercise_logs enable row level security;

drop policy if exists "exercise_logs_select_own" on public.exercise_logs;
create policy "exercise_logs_select_own" on public.exercise_logs
  for select using (auth.uid() = user_id);

drop policy if exists "exercise_logs_insert_own" on public.exercise_logs;
create policy "exercise_logs_insert_own" on public.exercise_logs
  for insert with check (auth.uid() = user_id);

drop policy if exists "exercise_logs_update_own" on public.exercise_logs;
create policy "exercise_logs_update_own" on public.exercise_logs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "exercise_logs_delete_own" on public.exercise_logs;
create policy "exercise_logs_delete_own" on public.exercise_logs
  for delete using (auth.uid() = user_id);

-- ─── progress_logs ─────────────────────────────────────────────────────
alter table public.progress_logs enable row level security;

drop policy if exists "progress_logs_select_own" on public.progress_logs;
create policy "progress_logs_select_own" on public.progress_logs
  for select using (auth.uid() = user_id);

drop policy if exists "progress_logs_insert_own" on public.progress_logs;
create policy "progress_logs_insert_own" on public.progress_logs
  for insert with check (auth.uid() = user_id);

drop policy if exists "progress_logs_update_own" on public.progress_logs;
create policy "progress_logs_update_own" on public.progress_logs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "progress_logs_delete_own" on public.progress_logs;
create policy "progress_logs_delete_own" on public.progress_logs
  for delete using (auth.uid() = user_id);
