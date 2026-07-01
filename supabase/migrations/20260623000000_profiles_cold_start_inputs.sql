-- Cold-start onboarding inputs: goal, priority, bodyweight, sex.
--
-- Three short inputs we ask in onboarding (after level / days / split) so the
-- starting-strength seed has something to work from and the coach can speak
-- the user's actual ambition ("built around getting your bench moving") on
-- session 1 instead of generic split copy. All four columns are NULL-able by
-- design — bodyweight + sex are skippable, and skipping just collapses the
-- seed back to a calibration entry (no fake number).
--
--   goal           — text enum: 'strength' | 'muscle' | 'general'. Drives
--                    plan_rationale phrasing and (later) volume / rep-range
--                    biasing. Stored as text + CHECK so adding a new option
--                    later is a one-line migration with no enum type churn.
--   priority       — text. Free-ish bucket the UI restricts to one of the
--                    muscle filter labels ('chest','back','shoulders','arms',
--                    'legs') or a key compound ('bench','squat','deadlift').
--                    NULL-able; "no preference" is a real answer.
--   bodyweight_kg  — numeric(5,2). NULL = user skipped → no seed. Range
--                    25..300 kg (CHECK) keeps obvious typos out without
--                    being judgmental.
--   sex            — text enum: 'male' | 'female' | 'unspecified'. Only used
--                    to bias the starting-strength ratios; never displayed.
--                    'unspecified' is the explicit "rather not say" answer.
--
-- Idempotent per CLAUDE.md — safe to re-run end-to-end.

alter table public.profiles
  add column if not exists goal text,
  add column if not exists priority text,
  add column if not exists bodyweight_kg numeric(5,2),
  add column if not exists sex text;

-- The previous schema enforced a different goal vocabulary
-- ('lose_fat' / 'build_muscle' / 'general_fitness' / 'mobility'). Drop that
-- constraint FIRST so the backfill UPDATEs are allowed to rewrite the
-- legacy strings — without this order, the existing CHECK refuses the new
-- 'muscle' / 'general' values mid-statement.
alter table public.profiles
  drop constraint if exists profiles_goal_check;

-- One-shot backfill of legacy goal vocabulary onto the closed set the new
-- onboarding writes. Mapping is obvious and lossless for the two values
-- that exist in prod ('build_muscle' / 'general_fitness'). 'lose_fat' and
-- 'mobility' were also part of the old CHECK enum but have no rows in
-- prod; they collapse to 'general' defensively in case a stray row appears
-- (re-runs stay no-ops because nothing matches by then).
update public.profiles set goal = 'muscle' where goal = 'build_muscle';
update public.profiles set goal = 'general' where goal in ('general_fitness', 'lose_fat', 'mobility');

-- goal: new allow-list. NULL permitted because legacy rows that pre-date
-- onboarding goal capture have no value to migrate.
alter table public.profiles
  add constraint profiles_goal_check
  check (goal is null or goal in ('strength', 'muscle', 'general'));

-- sex: small allow-list. 'unspecified' is the user-chosen value; NULL is the
-- legacy / never-asked value. Both are treated the same by the seed helper.
alter table public.profiles
  drop constraint if exists profiles_sex_check;
alter table public.profiles
  add constraint profiles_sex_check
  check (sex is null or sex in ('male', 'female', 'unspecified'));

-- bodyweight: cheap typo guard. We never reject "real" inputs — 25..300 kg
-- covers every plausible adult. The app rounds before write.
alter table public.profiles
  drop constraint if exists profiles_bodyweight_range;
alter table public.profiles
  add constraint profiles_bodyweight_range
  check (bodyweight_kg is null or (bodyweight_kg >= 25 and bodyweight_kg <= 300));
