-- Initial schema baseline.
--
-- These tables were originally created by hand in the Supabase dashboard, so no
-- migration ever created them — every later migration (RLS, indexes, added
-- columns) assumed they already existed. That meant `supabase db push` only
-- worked against the one hand-built prod project and would fail on a fresh
-- environment (CI, staging, a new clone) at the first `alter table ... enable
-- row level security`.
--
-- This file reconstructs the base tables from the live prod schema. It uses
-- `create table if not exists`, so it is a no-op against prod (where the tables
-- already exist) and creates them on a fresh project so the rest of the
-- migration chain can run end to end.
--
-- Columns added by later migrations are intentionally NOT included here; those
-- migrations remain the source of truth for them:
--   - workout_sessions.replanned   -> 20260527040000_workout_sessions_replanned
--   - exercise_logs.reps_in_reserve-> 20260530000000_exercise_logs_rir
--   - weekly_plans.plan_version    -> 20260604000000_weekly_plans_version

-- profiles (1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  fitness_level text check (fitness_level = any (array['beginner','intermediate','advanced'])),
  goal text check (goal = any (array['lose_fat','build_muscle','general_fitness','mobility'])),
  preferred_split text check (preferred_split = any (array['full_body','upper_lower','ppl','bro_split'])),
  onboarding_complete boolean default false,
  created_at timestamptz default timezone('utc', now()),
  training_days integer
);

-- exercises (public reference catalog)
create table if not exists public.exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  primary_muscle text not null,
  secondary_muscles text[],
  equipment text check (equipment = any (array['none','gym'])),
  difficulty text check (difficulty = any (array['beginner','intermediate','advanced'])),
  location text check (location = any (array['home','gym','both'])),
  sets_recommendation integer,
  reps_recommendation text,
  description text,
  illustration_url text,
  muscle_diagram_url text,
  created_at timestamptz default timezone('utc', now())
);

-- daily_checkins
create table if not exists public.daily_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  date date not null,
  energy_score integer not null check (energy_score >= 1 and energy_score <= 5),
  mood_tag text,
  reflection text,
  created_at timestamptz default now()
);

-- workout_sessions
create table if not exists public.workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  planned_date date not null,
  completed_at timestamptz,
  workout_type text,
  location text check (location = any (array['home','gym'])),
  energy_level text check (energy_level = any (array['low','normal','high'])),
  completed boolean default false,
  exercises_done jsonb,
  created_at timestamptz default timezone('utc', now())
);

-- weekly_plans
create table if not exists public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  week_start date not null,
  plan jsonb not null,
  created_at timestamptz default timezone('utc', now()),
  unique (user_id, week_start)
);

-- progress_logs
create table if not exists public.progress_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  logged_date date not null,
  weight_kg numeric(5,2),
  notes text,
  created_at timestamptz default timezone('utc', now())
);

-- exercise_logs (references auth.users + workout_sessions; created last)
create table if not exists public.exercise_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  exercise_name text not null,
  weight_kg numeric,
  logged_date date not null,
  session_id uuid references public.workout_sessions(id),
  created_at timestamptz default now()
);
