-- One row per non-cached replanner call. Used by the edge function to
-- enforce monthly limits and by analytics to track replanner usage.
--
-- Cached hits don't burn Anthropic credits, so they're not recorded here.

create table if not exists public.replan_calls (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  called_at     timestamptz not null default now(),
  accepted      boolean not null default false,
  energy_score  smallint
);

-- Composite index covering the limit-check query:
--   select count(*) from replan_calls where user_id = X
--   and called_at >= date_trunc('month', now())
create index if not exists replan_calls_user_called_idx
  on public.replan_calls (user_id, called_at desc);

alter table public.replan_calls enable row level security;

-- Users can read their own usage (for "X replans remaining this month" UI).
drop policy if exists "replan_calls_select_own" on public.replan_calls;
create policy "replan_calls_select_own" on public.replan_calls
  for select using (auth.uid() = user_id);

-- Inserts only via the edge function (service role), never from the client.
-- We leave INSERT/UPDATE/DELETE without policies so the anon role can't write.
-- The edge function uses the user's JWT but the inserts will be rejected
-- by RLS — so the edge fn must use the service role for writes.
-- ────────────────────────────────────────────────────────────────────────
-- Actually: simpler approach. Allow the user to insert their own row.
-- The edge function calls insert with the user's JWT and it works.
-- Server-side count check still happens before the insert, so client
-- can't bypass the limit by inserting bogus low counts (they can only
-- ADD calls, not subtract — and adding only makes their limit tighter).

drop policy if exists "replan_calls_insert_own" on public.replan_calls;
create policy "replan_calls_insert_own" on public.replan_calls
  for insert with check (auth.uid() = user_id);
