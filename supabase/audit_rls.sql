-- Paste into Supabase SQL editor to audit RLS state for the app tables.
-- Run as the dashboard user (postgres / service role).

WITH app_tables(name) AS (VALUES
  ('profiles'),
  ('weekly_plans'),
  ('workout_sessions'),
  ('exercise_logs'),
  ('progress_logs')
)
SELECT
  t.name AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  COALESCE(
    (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.name),
    0
  ) AS policy_count
FROM app_tables t
LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace
ORDER BY t.name;

-- And the actual policies, if any:
SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'profiles','weekly_plans',
    'workout_sessions','exercise_logs','progress_logs'
  )
ORDER BY tablename, policyname;
