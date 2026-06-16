-- Persist the pre-workout energy score (1–5) on the session row.
--
-- Energy is captured pre-workout but, until now, only landed in the
-- disposable `events` analytics table. The Training Status engine
-- (src/lib/trainingStatus.ts) needs a durable, per-session fatigue signal,
-- so we keep the score on workout_sessions itself.
--
-- Nullable: every pre-existing row predates the column and stays null, and
-- the rest-day / recovery paths may not capture energy. The check tolerates
-- null and only constrains real values to the 1–5 range the UI collects.
--
-- Idempotent end-to-end (add column if not exists; drop-then-add the check)
-- per the migration rules in CLAUDE.md.

alter table public.workout_sessions
  add column if not exists energy_score smallint;

alter table public.workout_sessions
  drop constraint if exists workout_sessions_energy_score_check;

alter table public.workout_sessions
  add constraint workout_sessions_energy_score_check
  check (energy_score is null or (energy_score >= 1 and energy_score <= 5));
