-- profiles.training_weekdays — user's selected training weekdays for the
-- new weekday picker (onboarding + Profile edit). Stored as a small int
-- array of 0..6 day-of-week indices (0 = Sunday … 6 = Saturday), matching
-- JavaScript Date.getDay(). NULL = no explicit selection; the generator
-- falls back to pickDefaultDayOffsets(training_days) so existing users and
-- 1/2/7-day day counts (out of scope for the picker) keep their current
-- behavior unchanged.
--
-- The column is the source of truth for WHICH calendar days the plan
-- schedules sessions on; training_days remains the count derived from
-- this array on write. ensureCurrentWeekPlan and deriveCanonicalWeek both
-- read it and convert it to the per-week selectedDayOffsets the generator
-- expects — that's the heal-idempotency contract.
--
-- Idempotent per CLAUDE.md — safe to re-run.

alter table public.profiles
  add column if not exists training_weekdays smallint[];

-- Constraint: every element must be a day-of-week index 0..6. NULL is
-- permitted (means "no explicit selection") and an empty array is treated
-- as equivalent to NULL by the app. The <@ ("is contained by") array
-- operator works inside a CHECK without a subquery (Postgres disallows
-- subqueries in CHECK expressions). Added with DROP+CREATE so the
-- migration stays re-runnable per the idempotency rule.
alter table public.profiles
  drop constraint if exists profiles_training_weekdays_range;
alter table public.profiles
  add constraint profiles_training_weekdays_range
  check (
    training_weekdays is null
    or array_length(training_weekdays, 1) is null
    or training_weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
  );
