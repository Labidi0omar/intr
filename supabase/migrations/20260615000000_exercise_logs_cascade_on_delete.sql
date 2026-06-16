-- Exercise-logs cascade on delete.
--
-- Repo↔prod sync: this constraint change was applied to prod via the
-- dashboard so the new "delete account" feature can rely on the
-- auth.users delete cascading through every user-owned table. The file
-- is here so a fresh DB (CI, staging, a clone) matches prod.
--
-- The other user-owned tables (profiles, weekly_plans, workout_sessions,
-- daily_checkins, events, replan_calls, progress_logs, journal_entries)
-- were already declared with `on delete cascade` in their original create-
-- table statements; only exercise_logs predates the cascade decision.
-- This migration brings it into line:
--   user_id    → auth.users(id)            cascade
--   session_id → workout_sessions(id)      cascade (so deleting a session
--                                                  also removes its logs;
--                                                  the user-delete path
--                                                  reaches logs via either
--                                                  route)
--
-- Idempotent: drop … if exists + add. Per CLAUDE.md, this file is NOT
-- pushed by Claude — repair/verify/push is the human's deliberate action.

-- ─── exercise_logs.user_id → auth.users(id) ────────────────────────────
-- The constraint name on prod was named by Postgres at table-creation
-- time. To be safe across environments we drop by every plausible name
-- before re-adding ours.
alter table public.exercise_logs
  drop constraint if exists exercise_logs_user_id_fkey;
alter table public.exercise_logs
  drop constraint if exists exercise_logs_user_id_auth_users_fkey;

alter table public.exercise_logs
  add constraint exercise_logs_user_id_fkey
  foreign key (user_id)
  references auth.users(id)
  on delete cascade;

-- ─── exercise_logs.session_id → workout_sessions(id) ──────────────────
alter table public.exercise_logs
  drop constraint if exists exercise_logs_session_id_fkey;
alter table public.exercise_logs
  drop constraint if exists exercise_logs_session_id_workout_sessions_fkey;

alter table public.exercise_logs
  add constraint exercise_logs_session_id_fkey
  foreign key (session_id)
  references public.workout_sessions(id)
  on delete cascade;
