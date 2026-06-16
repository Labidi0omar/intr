-- Recovery / prehab sessions.
--
-- Adds an `is_recovery` flag on workout_sessions and exercise_logs so the
-- coach can tell training data apart from prehab/mobility data. The product
-- requirement is asymmetric:
--   - Recovery sessions DO count toward the user's streak (habit + adherence
--     are the point — moving on a rest day is the win).
--   - Recovery sessions are INVISIBLE to load progression, PR detection,
--     RIR autoregulation, and the mesocycle. If recovery sets leak into
--     those systems the coach starts pulling progression decisions from
--     light-dose prehab, which corrupts the entire RIR engine.
--
-- The boolean column is the source of truth; src/lib/recovery.ts wraps the
-- read-side check so every consumer goes through one helper rather than
-- scattered string comparisons.
--
-- Idempotent. Re-runnable end-to-end. Per CLAUDE.md, this file is NOT pushed
-- by Claude — repair/verify/push is the human's deliberate action.

-- ─── workout_sessions ─────────────────────────────────────────────────
-- NOT NULL DEFAULT FALSE is a metadata-only operation in modern Postgres,
-- so the rewrite cost on a large table is negligible.
alter table public.workout_sessions
  add column if not exists is_recovery boolean not null default false;

-- ─── exercise_logs ────────────────────────────────────────────────────
-- Denormalized to exercise_logs so reads that don't join workout_sessions
-- (loadPrescription history, dashboard effort zone, PR detection) can scope
-- by a single column rather than a join. Writers must keep the two in sync —
-- pendingSync.attemptSave does this.
alter table public.exercise_logs
  add column if not exists is_recovery boolean not null default false;

-- ─── Partial indexes on training-only rows ───────────────────────────
-- Nearly every read filters is_recovery = false. Partial indexes keep the
-- common path fast without bloating storage with recovery rows that almost
-- nothing scans by exercise/date.
create index if not exists exercise_logs_user_training_idx
  on public.exercise_logs (user_id, logged_date desc)
  where is_recovery = false;

create index if not exists workout_sessions_user_training_idx
  on public.workout_sessions (user_id, planned_date desc)
  where is_recovery = false;
