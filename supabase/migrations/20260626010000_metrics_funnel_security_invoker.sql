-- Harden the funnel metrics views to run with the querying user's
-- permissions, not the view creator's.
--
-- The views in 20260625000000_metrics_funnel.sql were created without
-- `security_invoker`, so Postgres defaulted them to SECURITY DEFINER. Both
-- are in the API-exposed `public` schema, so the Supabase security advisor
-- flagged them ERROR-level (lint 0010_security_definer_view) — they would
-- read public.events with the definer's RLS, not the caller's.
--
-- security_invoker = on makes each view enforce the querying user's RLS on
-- the underlying public.events rows. Idempotent: ALTER VIEW ... SET is safe
-- to re-run, and these views always exist by this point in the chain.

alter view public.metrics_funnel set (security_invoker = on);
alter view public.metrics_prescription_trust set (security_invoker = on);
