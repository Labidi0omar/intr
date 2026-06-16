-- Security hardening (applied to prod 2026-06-04 via Supabase).
--
-- Context: the database was built by hand in the dashboard and accumulated
-- two issues the security/performance advisors flagged:
--   1. metrics_cohorts — a cross-user retention view — was SECURITY DEFINER
--      with SELECT granted to anon/authenticated, so any logged-in client
--      could read whole-userbase analytics. No app code references it.
--   2. RLS policies were inconsistent: some tables had a loose `FOR ALL`
--      policy with no WITH CHECK, workout_sessions had duplicate overlapping
--      policy sets, and every policy re-evaluated auth.uid() per row.
--
-- This migration is idempotent and represents the intended end state.

-- 1. Lock down the analytics view.
alter view public.metrics_cohorts set (security_invoker = on);
revoke all on public.metrics_cohorts from anon, authenticated;

-- 2. One clean per-action policy set per user-owned table, all using
--    (select auth.uid()) so it's evaluated once per query. Own-rows-only.

-- profiles (owner column = id; no delete by design)
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select_own on public.profiles for select using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- weekly_plans
drop policy if exists "Users can only access own weekly plans" on public.weekly_plans;
drop policy if exists weekly_plans_select_own on public.weekly_plans;
drop policy if exists weekly_plans_insert_own on public.weekly_plans;
drop policy if exists weekly_plans_update_own on public.weekly_plans;
drop policy if exists weekly_plans_delete_own on public.weekly_plans;
create policy weekly_plans_select_own on public.weekly_plans for select using ((select auth.uid()) = user_id);
create policy weekly_plans_insert_own on public.weekly_plans for insert with check ((select auth.uid()) = user_id);
create policy weekly_plans_update_own on public.weekly_plans for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy weekly_plans_delete_own on public.weekly_plans for delete using ((select auth.uid()) = user_id);

-- workout_sessions (collapse duplicate policy sets into one)
drop policy if exists "Users can only access own workout sessions" on public.workout_sessions;
drop policy if exists "Users can insert own workout sessions" on public.workout_sessions;
drop policy if exists "Users can read own workout sessions" on public.workout_sessions;
drop policy if exists "Users can update own workout sessions" on public.workout_sessions;
drop policy if exists workout_sessions_select_own on public.workout_sessions;
drop policy if exists workout_sessions_insert_own on public.workout_sessions;
drop policy if exists workout_sessions_update_own on public.workout_sessions;
drop policy if exists workout_sessions_delete_own on public.workout_sessions;
create policy workout_sessions_select_own on public.workout_sessions for select using ((select auth.uid()) = user_id);
create policy workout_sessions_insert_own on public.workout_sessions for insert with check ((select auth.uid()) = user_id);
create policy workout_sessions_update_own on public.workout_sessions for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy workout_sessions_delete_own on public.workout_sessions for delete using ((select auth.uid()) = user_id);

-- exercise_logs
drop policy if exists "Users can insert own exercise logs" on public.exercise_logs;
drop policy if exists "Users can read own exercise logs" on public.exercise_logs;
drop policy if exists exercise_logs_select_own on public.exercise_logs;
drop policy if exists exercise_logs_insert_own on public.exercise_logs;
drop policy if exists exercise_logs_update_own on public.exercise_logs;
drop policy if exists exercise_logs_delete_own on public.exercise_logs;
create policy exercise_logs_select_own on public.exercise_logs for select using ((select auth.uid()) = user_id);
create policy exercise_logs_insert_own on public.exercise_logs for insert with check ((select auth.uid()) = user_id);
create policy exercise_logs_update_own on public.exercise_logs for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy exercise_logs_delete_own on public.exercise_logs for delete using ((select auth.uid()) = user_id);

-- progress_logs
drop policy if exists "Users can only access own progress logs" on public.progress_logs;
drop policy if exists progress_logs_select_own on public.progress_logs;
drop policy if exists progress_logs_insert_own on public.progress_logs;
drop policy if exists progress_logs_update_own on public.progress_logs;
drop policy if exists progress_logs_delete_own on public.progress_logs;
create policy progress_logs_select_own on public.progress_logs for select using ((select auth.uid()) = user_id);
create policy progress_logs_insert_own on public.progress_logs for insert with check ((select auth.uid()) = user_id);
create policy progress_logs_update_own on public.progress_logs for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy progress_logs_delete_own on public.progress_logs for delete using ((select auth.uid()) = user_id);

-- daily_checkins
drop policy if exists daily_checkins_select_own on public.daily_checkins;
drop policy if exists daily_checkins_insert_own on public.daily_checkins;
drop policy if exists daily_checkins_update_own on public.daily_checkins;
drop policy if exists daily_checkins_delete_own on public.daily_checkins;
create policy daily_checkins_select_own on public.daily_checkins for select using ((select auth.uid()) = user_id);
create policy daily_checkins_insert_own on public.daily_checkins for insert with check ((select auth.uid()) = user_id);
create policy daily_checkins_update_own on public.daily_checkins for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy daily_checkins_delete_own on public.daily_checkins for delete using ((select auth.uid()) = user_id);

-- events (insert-only analytics; no client reads)
drop policy if exists events_insert_own on public.events;
create policy events_insert_own on public.events for insert with check ((select auth.uid()) = user_id);

-- replan_calls (select + insert)
drop policy if exists replan_calls_select_own on public.replan_calls;
drop policy if exists replan_calls_insert_own on public.replan_calls;
create policy replan_calls_select_own on public.replan_calls for select using ((select auth.uid()) = user_id);
create policy replan_calls_insert_own on public.replan_calls for insert with check ((select auth.uid()) = user_id);
