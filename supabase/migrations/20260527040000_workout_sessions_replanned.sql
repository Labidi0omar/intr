-- Track whether a session used the AI replanner.
-- Used by analytics + the metrics_cohorts view in future.

alter table public.workout_sessions
  add column if not exists replanned boolean not null default false;
