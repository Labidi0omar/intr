-- Stamp every weekly_plans row with the generator version that produced it.
--
-- Existing rows were written by the pre-versioning generator, so they default
-- to 0. ensureCurrentWeekPlan compares this against CURRENT_PLAN_VERSION
-- (src/lib/planGeneration.ts) and regenerates any FUTURE row whose version is
-- behind — letting generation-logic fixes (e.g. the bro_split multi-week
-- rotation fix) propagate to existing accounts on next app open, without
-- manual SQL deletes or a rebuild.

alter table public.weekly_plans
  add column if not exists plan_version integer not null default 0;
