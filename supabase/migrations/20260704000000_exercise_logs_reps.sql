-- exercise_logs.reps — captures the best-set rep count per lift per session
-- so the autoregulation engine can gate load progression on "hit the top of
-- the rep band cleanly." Without this column the top-of-band gate in
-- src/lib/loadPrescription.ts stays dormant (lastReps is always undefined).
--
-- smallint fits the domain comfortably (reps are always < 100 in practice)
-- and costs 2 bytes per row instead of int4's 4. Nullable because every
-- historical row predates this column — we do NOT backfill; the presenter
-- treats null as "no history to gate on" and falls through to the RIR-only
-- ladder, same as any legacy call site.
--
-- Idempotent: `add column if not exists` per CLAUDE.md's migration rules.

alter table public.exercise_logs
  add column if not exists reps smallint;

comment on column public.exercise_logs.reps is
  'Best-set rep count for this lift in this session. Nullable — populated for sessions logged after the reps-capture UI shipped; null on all pre-existing rows. Feeds the top-of-band gate in loadPrescription.';
