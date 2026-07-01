-- ─────────────────────────────────────────────────────────────────────────────
-- Admin role + read-only RLS for the intr-admin dashboard.
--
-- The dashboard is a static site that authenticates with the PUBLIC anon key and
-- relies entirely on RLS. This migration grants a designated admin account
-- read-only visibility across the tables the dashboard renders, without giving
-- the client any privileged key and without bypassing RLS.
--
-- Strictly ADDITIVE and IDEMPOTENT: existing own-row policies are left intact;
-- the new admin policies are additional permissive SELECT policies (OR'd with
-- the own-row policies). Re-running the whole file is safe.
--
-- Granting an actual account admin rights is a SEPARATE data step (not encoded
-- here, so no user id is hardcoded):
--     update public.profiles set is_admin = true where id = '<admin-uid>';
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Admin flag on profiles (default false → nobody is an admin until set).
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- 2. Helper: does the current auth user map to an admin profile?
--    SECURITY DEFINER so the function reads public.profiles WITHOUT being subject
--    to the RLS policies that themselves call it — this both lets the check work
--    and prevents infinite policy recursion. STABLE + pinned search_path.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_admin = true
  );
$$;

-- Only signed-in users need to call this (RLS policies evaluate it under the
-- authenticated role). Revoke from public + anon so an unauthenticated visitor
-- cannot probe admin status via the PostgREST /rpc/is_admin endpoint. The
-- remaining `authenticated` EXECUTE is required for the policies to run and is
-- the standard Supabase SECURITY DEFINER RLS-helper pattern.
revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

-- 3. Read-only admin SELECT policies. One per table the dashboard reads.
--    Admins get SELECT only — no admin INSERT/UPDATE/DELETE policies exist, so
--    even an authenticated admin cannot mutate other users' rows through RLS.

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated using ( public.is_admin() );

drop policy if exists workout_sessions_select_admin on public.workout_sessions;
create policy workout_sessions_select_admin on public.workout_sessions
  for select to authenticated using ( public.is_admin() );

drop policy if exists journal_entries_select_admin on public.journal_entries;
create policy journal_entries_select_admin on public.journal_entries
  for select to authenticated using ( public.is_admin() );

-- events currently has NO select policy at all (insert-only), so without this an
-- admin cannot read analytics events even after logging in.
drop policy if exists events_select_admin on public.events;
create policy events_select_admin on public.events
  for select to authenticated using ( public.is_admin() );

drop policy if exists exercise_logs_select_admin on public.exercise_logs;
create policy exercise_logs_select_admin on public.exercise_logs
  for select to authenticated using ( public.is_admin() );
