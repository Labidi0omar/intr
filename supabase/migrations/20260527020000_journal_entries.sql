-- Move journal entries from per-device AsyncStorage to Supabase so the
-- replanner (Sprint 2.1) can use them as context. AsyncStorage stays as
-- a write-through cache for offline reads.
--
-- One row per (user_id, date). Same upsert pattern as daily_checkins.

create table if not exists public.journal_entries (
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  user_text   text not null,
  ai_response text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, date)
);

create index if not exists journal_entries_user_date_idx
  on public.journal_entries (user_id, date desc);

alter table public.journal_entries enable row level security;

drop policy if exists "journal_entries_select_own" on public.journal_entries;
create policy "journal_entries_select_own" on public.journal_entries
  for select using (auth.uid() = user_id);

drop policy if exists "journal_entries_insert_own" on public.journal_entries;
create policy "journal_entries_insert_own" on public.journal_entries
  for insert with check (auth.uid() = user_id);

drop policy if exists "journal_entries_update_own" on public.journal_entries;
create policy "journal_entries_update_own" on public.journal_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "journal_entries_delete_own" on public.journal_entries;
create policy "journal_entries_delete_own" on public.journal_entries
  for delete using (auth.uid() = user_id);
