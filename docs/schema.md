# Flux Database Schema

Generated: 2026-05-24  
Database: Supabase (PostgreSQL)  
Project: `ehbbpawgntvykkiioukl`

---

## Tables

### 1. `profiles`
User profile, created on sign-up, updated on onboarding, profile edits.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, FK → `auth.users.id` |
| `username` | TEXT | nullable |
| `training_days` | INTEGER | |
| `preferred_split` | TEXT | `full_body` / `upper_lower` / `ppl` / `bro_split` |
| `fitness_level` | TEXT | `beginner` / `intermediate` / `advanced` |
| `goal` | TEXT | `build_muscle` / `lose_weight` / `improve_endurance` / `general_fitness` |
| `onboarding_complete` | BOOLEAN | |

Write paths:
- `app/onboarding.tsx` — upsert (id, training_days, preferred_split, fitness_level, onboarding_complete)
- `app/(tabs)/profile.tsx` — update (goal, username, etc.)
- `app/(tabs)/home.tsx` — update (progression: fitness_level, preferred_split)

Read paths:
- `app/(tabs)/home.tsx` — fetchDashboardData
- `app/(tabs)/plan.tsx` — read fitness_level and preferred_split for plan generation

---

### 2. `weekly_plans`
One row per user per week. Stores the full AI-generated workout plan as JSONB.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | auto-generated PK |
| `user_id` | UUID | FK → `auth.users.id` |
| `week_start` | DATE | NOT NULL |
| `plan` | JSONB | Array of PlanDay objects |
| **UK** | | (`user_id`, `week_start`) |

PlanDay shape (JSONB):
```json
{
  "day": "Monday",
  "location": "gym",
  "workoutType": "Push",
  "muscleGroups": ["chest", "shoulders", "triceps"],
  "exercises": [
    {
      "name": "Barbell Bench Press",
      "equipment": "barbell",
      "primaryMuscle": "chest",
      "sets": 4,
      "reps": "8-12",
      "restSeconds": 90,
      "imageUrl": "https://..."
    }
  ]
}
```

Write paths:
- `app/(tabs)/plan.tsx` — upsert on `(user_id, week_start)`

Read paths:
- `app/workout.tsx` — fetchTodayPlan
- `app/(tabs)/home.tsx` — fetchDashboardData

---

### 3. `workout_sessions`
One row per completed OR in-progress workout session per day.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | auto-generated PK |
| `user_id` | UUID | FK → `auth.users.id` |
| `planned_date` | DATE | |
| `completed_at` | TIMESTAMPTZ | nullable |
| `workout_type` | TEXT | e.g. "Push", "Pull", "Legs" |
| `location` | TEXT | `gym` / `home` |
| `energy_level` | TEXT | `low` / `normal` / `high` |
| `completed` | BOOLEAN | |
| `exercises_done` | JSONB | Array of Exercise objects |

Write paths:
- `app/workout.tsx` — INSERT on completeWorkout (checked for duplicate first)

Read paths:
- `app/(tabs)/home.tsx` — recent sessions, today's completion, weekly completion count
- `app/(tabs)/home.tsx` — `energy_level` (mapped 1-5) drives the dashboard history timeline + weekly-insight low-energy count
- `app/(tabs)/journal.tsx` — `energy_level` for today's session is mapped to 1-5 and passed to daily-reflection
- `src/utils/gapDetection.ts` — most recent `planned_date` with `completed = true` defines the return-gap (semantics: days since last completed workout, not days since last check-in)
- `supabase/functions/replan-today/` — last 14 completed sessions feed the replanner as energy context (`mood_tag` no longer captured)

---

### 4. `exercise_logs`
Per-exercise weight logs. One row per exercise per session.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | auto-generated PK |
| `user_id` | UUID | FK → `auth.users.id` |
| `exercise_name` | TEXT | |
| `weight_kg` | FLOAT | |
| `logged_date` | DATE | |
| `session_id` | UUID | nullable, FK → `workout_sessions.id` |

Write paths:
- `app/workout.tsx` — INSERT batch on completeWorkout

Read paths:
- `app/workout.tsx` — PR detection (compare against previous logs)

---

### 5. `progress_logs`
Body weight tracking. Separate from workout weight logs.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | auto-generated PK |
| `user_id` | UUID | FK → `auth.users.id` |
| `weight_kg` | FLOAT | |
| `logged_date` | DATE | |
| `created_at` | TIMESTAMPTZ | |

Write paths:
- `app/(tabs)/progress.tsx` (body weight entry)

Read paths:
- `app/(tabs)/home.tsx` — latest weight for profile summary card

---

## Auth Tables (Supabase managed)

### `auth.users`
Standard Supabase Auth table. Referenced by all `user_id` FKs above.

---

## Indexes (inferred from query patterns)

| Table | Query Pattern | Suggestion |
|-------|--------------|------------|
| `workout_sessions` | `WHERE user_id = X AND planned_date = Y` | Index on `(user_id, planned_date)` |
| `workout_sessions` | `WHERE user_id = X ORDER BY completed_at DESC LIMIT N` | Index on `(user_id, completed_at DESC)` |
| `exercise_logs` | `WHERE user_id = X AND exercise_name IN (...)` | Index on `(user_id, exercise_name)` |
| `weekly_plans` | `WHERE user_id = X AND week_start <= Y ORDER BY week_start DESC LIMIT 1` | Index on `(user_id, week_start DESC)` |

---

## Edge Functions

| Function | Path | Model | Purpose |
|----------|------|-------|---------|
| `daily-reflection` | `supabase/functions/daily-reflection/index.ts` | Claude Haiku 4.5 | Generate daily (40-80 words) or biweekly (80-100 words) reflection text |
| `generate-plan` | `supabase/functions/generate-plan/index.ts` | Claude Haiku 4.5 | Generate weekly workout plan from user profile + exercise library |

Both use `ANTHROPIC_API_KEY` env var (Supabase secret).