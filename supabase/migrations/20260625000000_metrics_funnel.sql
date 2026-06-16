-- Metrics views for the activation + monetization funnel.
-- Idempotent: every view uses `create or replace view`; no destructive DDL.
-- Read-only — these are query surfaces only, populated from public.events.
--
-- Pair with the wired events in src/lib/analytics.ts (Part 1 + Part 2 of
-- the instrument-the-funnel work). Existing metrics_cohorts continues to
-- own the D7 retention question; the new views answer "where do users
-- drop on the way through?" and "does the load engine's load suggestion
-- feel right as users get further in?"

-- ─── metrics_funnel ────────────────────────────────────────────────────
-- One row per ordered funnel step, with distinct-user counts and the
-- step-to-step conversion %. The step order encodes a strict prerequisite
-- chain: signup → onboarding_started → onboarding_completed → plan_ready →
-- workout_started → workout_completed → activation_reached → paywall_shown
-- → subscription_started.
--
-- "distinct users at step" counts a user once if they ever emitted that
-- event. "conversion_from_prev_pct" is the % of users at the previous
-- step who reached this step — the drop-off readout. The first step's
-- prev_users is null and the conversion shows as null too (no previous
-- step to convert from).

create or replace view public.metrics_funnel as
with step_defs(step_order, step_name) as (
  -- VALUES literal so EVERY step gets a row even at zero users — using a
  -- UNION ALL over the events table would silently drop empty steps and
  -- mis-attribute the next step's prev_users via lag().
  values
    (1, 'signup'),
    (2, 'onboarding_started'),
    (3, 'onboarding_completed'),
    (4, 'plan_ready'),
    (5, 'workout_started'),
    (6, 'workout_completed'),
    (7, 'activation_reached'),
    (8, 'paywall_shown'),
    (9, 'subscription_started')
),
event_users as (
  select event_name, count(distinct user_id) as users
  from public.events
  where event_name in (
    'signup', 'onboarding_started', 'onboarding_completed', 'plan_ready',
    'workout_started', 'workout_completed', 'activation_reached',
    'paywall_shown', 'subscription_started'
  )
  group by event_name
),
steps as (
  select sd.step_order, sd.step_name, coalesce(eu.users, 0) as users
  from step_defs sd
  left join event_users eu on eu.event_name = sd.step_name
),
-- lag() brings the previous step's user count onto each row so the
-- step-to-step conversion lands in one read. step_defs guarantees the
-- ordering is dense (no gaps), so lag() reads the right neighbor.
with_prev as (
  select
    step_order,
    step_name,
    users,
    lag(users) over (order by step_order) as prev_users
  from steps
)
select
  step_order,
  step_name,
  users                                                          as users_at_step,
  prev_users                                                     as users_at_prev_step,
  case
    when prev_users is null or prev_users = 0 then null
    else round(100.0 * users / prev_users, 1)
  end                                                            as conversion_from_prev_pct
from with_prev
order by step_order;


-- ─── metrics_prescription_trust ────────────────────────────────────────
-- The load engine's autoregulator suggests a weight per exercise per
-- session. prescription_outcome events emit `followed` (did the user
-- log the suggested weight, within tolerance) and `hit_target_zone`
-- (did the resulting RIR land in 1–2). Together they're a proxy for
-- "does the suggestion feel right?" — the inverse signal is the
-- "a suggestion felt wrong, churn brewing" early warning.
--
-- Bucketed by session_index ranges so a single bad session doesn't
-- show as a spike. Buckets: 1–3 (calibration window), 4–6 (engine has
-- enough signal), 7+ (steady state). Counts are distinct-set: every
-- prescription_outcome row counts once.
--
-- Notes:
--  • session_index is sourced from the JSON property on the
--    prescription_outcome event itself — workout.tsx does not include
--    it on prescription_outcome rows yet. We fall back to the user's
--    workout_completed count up to the event's created_at when the
--    JSON value is missing, so the view reads correctly without
--    requiring a workout.tsx payload change.
--  • Boolean coercion handles JSON booleans AND JSON strings
--    (`'true'`/`'false'`) without changing the workout.tsx call site.

create or replace view public.metrics_prescription_trust as
with outcomes as (
  select
    e.user_id,
    e.created_at,
    -- followed / hit_target_zone may arrive as either jsonb booleans
    -- or string-typed properties depending on the client serializer.
    -- The text cast normalises both to a bool comparison.
    case
      when (e.properties ->> 'followed') in ('true', 't', '1') then true
      when (e.properties ->> 'followed') in ('false', 'f', '0') then false
      else null
    end as followed,
    case
      when (e.properties ->> 'hit_target_zone') in ('true', 't', '1') then true
      when (e.properties ->> 'hit_target_zone') in ('false', 'f', '0') then false
      else null
    end as hit_target_zone,
    -- Backfill session_index from completed-workout history up to this
    -- event's created_at when the property is absent. Subquery is bounded
    -- by user_id and indexed on (user_id, created_at desc), so it stays
    -- cheap even on large event tables.
    coalesce(
      nullif(e.properties ->> 'session_index', '')::int,
      (
        select count(*)
        from public.events ce
        where ce.user_id = e.user_id
          and ce.event_name = 'workout_completed'
          and ce.created_at <= e.created_at
      )
    ) as session_index
  from public.events e
  where e.event_name = 'prescription_outcome'
),
bucketed as (
  select
    case
      when session_index between 1 and 3 then '1-3'
      when session_index between 4 and 6 then '4-6'
      when session_index >= 7            then '7+'
      else 'unknown'
    end as session_bucket,
    followed,
    hit_target_zone
  from outcomes
)
select
  session_bucket,
  count(*)                                          as outcomes_total,
  count(*) filter (where followed = true)            as followed_count,
  count(*) filter (where hit_target_zone = true)     as hit_target_zone_count,
  case
    when count(*) filter (where followed is not null) = 0 then null
    else round(
      100.0 * count(*) filter (where followed = true) /
      count(*) filter (where followed is not null),
      1
    )
  end                                                as followed_pct,
  case
    when count(*) filter (where hit_target_zone is not null) = 0 then null
    else round(
      100.0 * count(*) filter (where hit_target_zone = true) /
      count(*) filter (where hit_target_zone is not null),
      1
    )
  end                                                as hit_target_zone_pct
from bucketed
group by session_bucket
order by
  case session_bucket
    when '1-3' then 1
    when '4-6' then 2
    when '7+'  then 3
    when 'unknown' then 4
  end;
