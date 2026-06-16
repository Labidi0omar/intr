-- Capture reps-in-reserve per logged exercise. Nullable: legacy rows and
-- skipped logs have no RIR. smallint 0..5 (5 = "5+ reps left / very easy").
-- This column is the input signal for the RIR-driven load prescription engine
-- (src/lib/loadPrescription.ts).

alter table public.exercise_logs
  add column if not exists reps_in_reserve smallint;

-- Optional sanity bound. Keep it loose; the client clamps to 0..5 anyway.
alter table public.exercise_logs
  drop constraint if exists exercise_logs_rir_range;

alter table public.exercise_logs
  add constraint exercise_logs_rir_range
  check (reps_in_reserve is null or (reps_in_reserve >= 0 and reps_in_reserve <= 5));

-- The load-prescription query reads the most recent log per (user, exercise).
-- Add the covering index if it isn't already present.
create index if not exists exercise_logs_user_exercise_date_idx
  on public.exercise_logs (user_id, exercise_name, logged_date desc);
