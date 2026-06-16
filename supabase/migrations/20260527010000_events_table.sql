-- Single events table for product analytics.
-- Idempotent: safe to re-run.
--
-- Keep schema minimal — the goal is to answer one question on Fridays:
-- "what's my D7 retention from session 3?"

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  event_name  text not null,
  properties  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists events_user_id_created_at_idx
  on public.events (user_id, created_at desc);

create index if not exists events_event_name_created_at_idx
  on public.events (event_name, created_at desc);

-- RLS: users can insert their own events; reads are blocked at the policy
-- level (analytics are queried with the service role from the dashboard).
alter table public.events enable row level security;

drop policy if exists "events_insert_own" on public.events;
create policy "events_insert_own" on public.events
  for insert with check (auth.uid() = user_id);

-- ─── Cohort metrics view ──────────────────────────────────────────────
-- Run from the Supabase SQL editor or pin in the dashboard. Refresh manually
-- each Friday; aggregate cost is trivial for the first 12 months.

create or replace view public.metrics_cohorts as
with completions as (
  select
    user_id,
    created_at,
    row_number() over (partition by user_id order by created_at) as session_index
  from public.events
  where event_name = 'workout_completed'
),
session_3 as (
  -- The timestamp at which each user first hit session #3
  select user_id, created_at as reached_at
  from completions
  where session_index = 3
),
later_activity as (
  select distinct s3.user_id
  from session_3 s3
  join public.events e
    on e.user_id = s3.user_id
   and e.created_at between s3.reached_at + interval '6 days' and s3.reached_at + interval '8 days'
   and e.event_name in ('workout_started', 'workout_completed')
)
select
  date_trunc('week', s3.reached_at)              as cohort_week,
  count(distinct s3.user_id)                     as reached_session_3,
  count(distinct la.user_id)                     as d7_returners,
  round(
    100.0 * count(distinct la.user_id) / nullif(count(distinct s3.user_id), 0),
    1
  ) as d7_retention_pct
from session_3 s3
left join later_activity la on la.user_id = s3.user_id
group by date_trunc('week', s3.reached_at)
order by cohort_week desc;
