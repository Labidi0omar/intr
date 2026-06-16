-- Metrics view: does following the coach's load suggestion lead to better
-- training outcomes than overriding it?
--
-- Source events (emitted by src/lib/analytics.ts via src/lib/loadPrescription.ts):
--   prescription_shown    -- a suggested weight was presented to the user
--   prescription_outcome  -- one row per logged exercise that had a prescription,
--                            carrying { followed, hit_target_zone, rationale, ... }
--
-- Refresh pattern: this is a view, not a materialized view. Query on demand
-- from the Supabase SQL editor; aggregate cost is negligible at our scale.
-- Read with the service role (RLS on `events` blocks user-side reads).
--
-- The decision question the view answers:
--   "Among outcomes where the user followed the suggestion, do they land in
--    the RIR 1–2 target zone more often than when they override it?"
-- If followed_target_zone_pct > overridden_target_zone_pct consistently,
-- the engine is doing real work.

create or replace view public.metrics_prescription_efficacy as
with outcomes as (
  select
    date_trunc('week', created_at)                                as week,
    coalesce(properties->>'rationale', 'unknown')                 as rationale,
    (properties->>'followed')::boolean                            as followed,
    (properties->>'hit_target_zone')::boolean                     as hit_target_zone,
    nullif(properties->>'rir_logged', '')::int                    as rir_logged
  from public.events
  where event_name = 'prescription_outcome'
    and created_at >= now() - interval '4 weeks'
),
shown as (
  select
    date_trunc('week', created_at)                                as week,
    coalesce(properties->>'rationale', 'unknown')                 as rationale,
    count(*)                                                      as shown_count
  from public.events
  where event_name = 'prescription_shown'
    and created_at >= now() - interval '4 weeks'
  group by 1, 2
)
select
  o.week,
  o.rationale,
  s.shown_count,
  count(*)                                                        as outcomes_total,
  count(*) filter (where o.followed)                              as outcomes_followed,
  round(
    100.0 * count(*) filter (where o.followed)
          / nullif(count(*), 0),
    1
  )                                                               as follow_rate_pct,
  -- The head-to-head: target-zone hit rate among followed vs. overridden.
  -- If this gap is positive and stable, the prescription is the cause.
  round(
    100.0 * count(*) filter (where o.followed and o.hit_target_zone)
          / nullif(count(*) filter (where o.followed), 0),
    1
  )                                                               as followed_target_zone_pct,
  round(
    100.0 * count(*) filter (where not o.followed and o.hit_target_zone)
          / nullif(count(*) filter (where not o.followed), 0),
    1
  )                                                               as overridden_target_zone_pct,
  -- Useful sanity: RIR distribution across all outcomes this week.
  round(avg(o.rir_logged)::numeric, 2)                            as avg_rir_logged
from outcomes o
left join shown s
  on s.week = o.week
 and s.rationale = o.rationale
group by o.week, o.rationale, s.shown_count
order by o.week desc, o.rationale;
