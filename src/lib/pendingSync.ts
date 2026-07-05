// Finish-workout save queue.
//
// Scope: ONLY the writes finishWorkout performs (workout_sessions row +
// exercise_logs batch). A generic offline queue for every supabase write is
// a deliberate follow-up — not in this module.
//
// Contract:
//   - The finish flow tries each write, retries once on error, and on
//     persistent failure persists the full save (session fields + logRows
//     including weights and RIR) under pendingWorkoutSave:{userId}:{date}.
//     The user always reaches the complete screen — the queue carries the
//     data forward, the UI tells the truth.
//   - flushPendingSaves() runs on app launch/focus, replays each queued
//     blob, and clears the key on success. Persistent failures stay queued
//     and are reported to Sentry so we can see them in prod.
//   - Replay is idempotent against partial prior success: an existing
//     workout_sessions row is updated rather than re-inserted. exercise_logs
//     dupes on retry are tolerated — the table has no natural unique key on
//     (user, exercise, date), and PR detection windows by date, so a dupe
//     row doesn't fabricate a PR. Losing the data outright would be worse.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { supabase } from './supabase';

const KEY_PREFIX = 'pendingWorkoutSave:';

// Shape stored in AsyncStorage. Keep field names aligned with the columns
// finishWorkout already writes so replay is a literal pass-through.
export interface PendingLogRow {
  user_id: string;
  exercise_name: string;
  /** Numeric kg, or null for bodyweight / duration-only rows (e.g. core /
   *  calves logged from the rest-day picker, where no weight is captured).
   *  Null rows are still persisted so the session counts toward the streak
   *  and the week-progress card, but they can't seed last-weights or PR
   *  detection — parseWeightKg drops nulls. */
  weight_kg: number | null;
  logged_date: string;
  /** Filled in by attemptSave once the session row exists; null when queued
   *  from a finish that never got a session id. */
  session_id: string | null;
  reps_in_reserve: number | null;
  /** Recovery flag. Defaults to false on the normal finish path; true for
   *  recovery sessions (future prompt). Must match the parent session's flag
   *  so the read-side exclusion holds. See src/lib/recovery.ts. */
  is_recovery?: boolean;
}

export interface PendingSessionFields {
  user_id: string;
  planned_date: string;
  workout_type?: string;
  location?: string;
  energy_level: 'low' | 'normal' | 'high';
  /** Raw pre-workout energy score (1–5). Durable signal for the Training
   *  Status engine; the lossy `energy_level` bucket above is kept for the
   *  existing history/coach reads. Optional so legacy queued saves (written
   *  before this field existed) replay without a shape mismatch — a missing
   *  value simply writes null. */
  energy_score?: number | null;
  exercises_done: unknown;
  completed: boolean;
  completed_at: string;
  replanned: boolean;
  /** Recovery flag. Default false (omitted) on the normal training save
   *  path. When true, the lookup is scoped by is_recovery=true so a recovery
   *  save never collides with a same-day normal session. */
  is_recovery?: boolean;
}

export interface PendingSave {
  userId: string;
  plannedDate: string;
  session: PendingSessionFields;
  logRows: PendingLogRow[];
  /** ISO timestamp. Useful only for diagnostics — flush is FIFO-agnostic. */
  queuedAt: string;
}

export type AttemptResult =
  // wasFresh = true when no workout_sessions row existed for this
  // (user, planned_date) BEFORE this attempt — finishWorkout uses it to gate
  // the workout_completed analytics emit so subsequent finishes on the same
  // day don't double-count.
  | { ok: true; sessionId: string | null; wasFresh: boolean }
  | { ok: false; error: unknown };

function keyFor(userId: string, date: string): string {
  return `${KEY_PREFIX}${userId}:${date}`;
}

/**
 * One attempt at the full save. Mirrors what finishWorkout used to do
 * inline:
 *   1. Look up an existing workout_sessions row by (user_id, planned_date).
 *   2. Insert (fresh) or update (subsequent attempt).
 *   3. Insert exercise_logs with session_id wired through.
 *
 * Returns a discriminated union — never throws. Any per-step Supabase error
 * short-circuits with { ok: false, error }. Unexpected exceptions are
 * caught and surfaced the same way so the caller can treat every failure
 * uniformly.
 */
export async function attemptSave(save: PendingSave): Promise<AttemptResult> {
  try {
    const { session, logRows } = save;

    // Scope the lookup by is_recovery (default false) so a normal-finish
    // save never updates a same-day recovery row and vice-versa. Without
    // this scoping, a user who does a normal workout in the morning and a
    // recovery session in the evening on the same date would collide on
    // (user, planned_date) and the second save would mutate the first.
    const sessionIsRecovery = session.is_recovery === true;
    const { data: existing, error: lookupErr } = await supabase
      .from('workout_sessions')
      .select('id')
      .eq('user_id', session.user_id)
      .eq('planned_date', session.planned_date)
      .eq('is_recovery', sessionIsRecovery)
      .limit(1);
    if (lookupErr) return { ok: false, error: lookupErr };

    let sessionId: string | null = (existing as { id: string }[] | null)?.[0]?.id ?? null;
    const wasFresh = sessionId === null;

    if (!sessionId) {
      const { data: inserted, error: insErr } = await supabase
        .from('workout_sessions')
        .insert(session)
        .select();
      if (insErr) return { ok: false, error: insErr };
      sessionId = (inserted as { id: string }[] | null)?.[0]?.id ?? null;
    } else {
      const { error: updErr } = await supabase
        .from('workout_sessions')
        .update({
          exercises_done: session.exercises_done,
          completed_at: session.completed_at,
          energy_level: session.energy_level,
          energy_score: session.energy_score ?? null,
          replanned: session.replanned,
        })
        .eq('id', sessionId);
      if (updErr) return { ok: false, error: updErr };
    }

    if (logRows.length > 0) {
      // Wire the (possibly just-created) session id into every row so a
      // queued save from before the session existed gets linked on replay.
      // Also stamp is_recovery from the parent session — the helper-driven
      // read-side filter depends on the log rows carrying the tag too.
      const rowsWithId = logRows.map(r => ({
        ...r,
        session_id: sessionId,
        is_recovery: r.is_recovery ?? sessionIsRecovery,
      }));
      const { error: logErr } = await supabase
        .from('exercise_logs')
        .insert(rowsWithId);
      if (logErr) return { ok: false, error: logErr };
    }

    return { ok: true, sessionId, wasFresh };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** Run attemptSave up to maxAttempts times (default 2 = original + 1 retry).
 *  Returns the final result. Stops early on first success. */
export async function attemptSaveWithRetry(
  save: PendingSave,
  maxAttempts = 2,
): Promise<AttemptResult> {
  let last: AttemptResult = { ok: false, error: new Error('no attempts made') };
  for (let i = 0; i < maxAttempts; i++) {
    last = await attemptSave(save);
    if (last.ok) return last;
  }
  return last;
}

/** Persist the failed save so the next launch/focus can retry. Overwrites
 *  any existing queued blob for the same (user, date) — there is at most
 *  one pending save per workout day. */
export async function enqueuePendingSave(save: PendingSave): Promise<void> {
  await AsyncStorage.setItem(keyFor(save.userId, save.plannedDate), JSON.stringify(save));
}

/**
 * Run the durable save with WRITE-AHEAD semantics: enqueue the save to
 * AsyncStorage FIRST, then attempt the network write, then remove the
 * queue entry on confirmed success. Never throws.
 *
 * Why write-ahead. The workout finish flow flips phase → 'complete'
 * optimistically (immediately after building the save from in-memory
 * state), so the network write happens while the user is already on the
 * summary screen. A hard app-kill in that window used to leave nothing
 * durable — the queue was only written AFTER a persistent network
 * failure. With write-ahead, the queue entry exists before the very
 * first Supabase call, so flushPendingSaves() on next launch always
 * finds the save.
 *
 * Ordering:
 *   1. enqueuePendingSave(save)            — write-ahead entry
 *   2. attemptSaveWithRetry(save)          — network write, once + retry
 *   3a. success → clearPendingSave()       — remove the queue entry
 *   3b. failure → leave the queue entry    — flushPendingSaves replays
 *
 * Edge cases:
 *   - Step 1 fails (AsyncStorage OOM / disk full). We report and press
 *     on to the network write. If the network succeeds, no data loss.
 *     If the network fails, the caller sees enqueued=false and treats
 *     this as the "very-bad" last-resort case (same as pre-write-ahead).
 *   - Step 3a fails (AsyncStorage clear failed). The queue entry
 *     survives; the next launch's flushPendingSaves replays it. Replay
 *     is idempotent by design (an existing workout_sessions row is
 *     updated instead of re-inserted — see the module doc header). The
 *     caller still sees ok=true / enqueued=false because the data IS
 *     safely persisted server-side.
 *   - Called from the same-day retry path: enqueuePendingSave uses
 *     setItem which OVERWRITES existing keys, so a stale prior WAL
 *     entry for the same (user, date) is replaced, not duplicated.
 *
 * Returns:
 *   - ok=true         → server has the save. enqueued=false. WAL was
 *                       written and cleared; if the clear failed, the
 *                       next launch's replay is a no-op.
 *   - ok=false, enqueued=true  → the save is durable in the queue.
 *                       flushPendingSaves on next launch will retry.
 *   - ok=false, enqueued=false → BOTH the WAL write AND the network
 *                       write failed. The caller's outer catch treats
 *                       this as the very-bad last-resort path.
 */
export async function runDurableSave(save: PendingSave): Promise<{
  ok: boolean;
  sessionId: string | null;
  wasFresh: boolean;
  enqueued: boolean;
  error?: unknown;
}> {
  // Step 1: WRITE-AHEAD. Any failure to reach step 2 or step 3 (kill,
  // crash, OOM, offline) is now recoverable because the full save
  // (session fields + logRows including weights and RIR) is in
  // AsyncStorage before we make a single Supabase call.
  let walOk = true;
  try {
    await enqueuePendingSave(save);
  } catch (walErr) {
    walOk = false;
    // Best-effort — proceed to the network write anyway. If the network
    // succeeds, there's no data loss; if it fails, `enqueued: false` is
    // returned and the caller's outer catch treats this as last-resort.
    Sentry.captureException(walErr);
  }

  // Step 2: network write, with one retry.
  let result: AttemptResult;
  try {
    result = await attemptSaveWithRetry(save);
  } catch (e) {
    // attemptSave swallows its own errors via the internal try/catch, so
    // this branch is genuinely belt-and-suspenders. If the chain itself
    // threw (e.g. supabase client construction error), we treat it as a
    // failed attempt and leave the WAL entry in place.
    result = { ok: false, error: e };
  }

  if (result.ok) {
    // Step 3a: network succeeded. Remove the WAL entry so the next
    // launch's flushPendingSaves doesn't replay it. A failed clear is
    // tolerated — replay is idempotent (updates the existing session
    // row), so a stray WAL entry costs one no-op flush on next boot.
    try {
      await clearPendingSave(save.userId, save.plannedDate);
    } catch (clearErr) {
      Sentry.captureException(clearErr);
    }
    return { ok: true, sessionId: result.sessionId, wasFresh: result.wasFresh, enqueued: false };
  }

  // Step 3b: network failed. If the WAL landed (walOk), the save is
  // durable and flushPendingSaves picks it up next launch. If the WAL
  // ALSO failed (walOk === false), we have nothing — the caller's
  // outer catch is the last resort.
  return {
    ok: false,
    sessionId: null,
    wasFresh: false,
    enqueued: walOk,
    error: result.error,
  };
}

/**
 * Orchestrate the durable save AND the best-effort prior-log fetch the
 * finish flow needs for PR detection.
 *
 * Order is the contract: the save runs FIRST. Only after the save is
 * committed (network or queue) do we fetch prior logs for PR comparison.
 * The prior-log fetch is best-effort — its rejection becomes priorLogsError
 * and produces an empty priorLogs array; it CANNOT abort the save.
 *
 * Extracted from app/workout.tsx::finishWorkout specifically so the
 * regression "PR read throws → save still enqueues" is testable without a
 * React component render.
 */
/** Prior-log row for PR detection. logged_date rides along so the PR
 *  comparison can exclude rows from the session itself — the save runs
 *  BEFORE the fetch, so the session's own rows are in the table by the
 *  time the fetch executes. */
export interface PriorLog {
  exercise_name: string;
  weight_kg: number;
  logged_date?: string;
}

export interface FinishPersistenceResult {
  saveOk: boolean;
  sessionId: string | null;
  wasFresh: boolean;
  enqueued: boolean;
  saveError?: unknown;
  priorLogs: PriorLog[];
  priorLogsError?: unknown;
}

export async function runFinishPersistence(
  save: PendingSave,
  opts: {
    /** Async fetch of prior logs for PR detection. May reject — caller is
     *  shielded by an internal try/catch. */
    fetchPriorLogs: () => Promise<PriorLog[]>;
  },
): Promise<FinishPersistenceResult> {
  // 1. SAVE FIRST. This is what the user tapped Finish for; nothing below
  //    can be allowed to undo it.
  const durable = await runDurableSave(save);

  // 2. Best-effort prior-log fetch. A throw here is absorbed — PR
  //    detection is decorative and must never block or undo the save.
  let priorLogs: PriorLog[] = [];
  let priorLogsError: unknown;
  try {
    priorLogs = await opts.fetchPriorLogs();
  } catch (e) {
    priorLogsError = e;
  }

  return {
    saveOk: durable.ok,
    sessionId: durable.sessionId,
    wasFresh: durable.wasFresh,
    enqueued: durable.enqueued,
    saveError: durable.error,
    priorLogs,
    priorLogsError,
  };
}

export async function clearPendingSave(userId: string, date: string): Promise<void> {
  await AsyncStorage.removeItem(keyFor(userId, date));
}

export async function loadPendingSave(userId: string, date: string): Promise<PendingSave | null> {
  const raw = await AsyncStorage.getItem(keyFor(userId, date));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingSave;
  } catch (e) {
    Sentry.captureException(e);
    return null;
  }
}

/**
 * Replay every queued save. Successful flushes clear their key; persistent
 * failures stay queued AND are reported to Sentry so we can see them in
 * prod (silent drop would defeat the whole point of the queue).
 *
 * Safe to call from any focus / launch hook — concurrent calls just race on
 * the same AsyncStorage keys; the worst case is a duplicate insert, which
 * we already tolerate.
 */
export async function flushPendingSaves(): Promise<{ flushed: number; remaining: number }> {
  let flushed = 0;
  let remaining = 0;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const pending = keys.filter(k => k.startsWith(KEY_PREFIX));
    for (const k of pending) {
      const raw = await AsyncStorage.getItem(k);
      if (!raw) {
        // Key vanished between getAllKeys and read — nothing to do.
        await AsyncStorage.removeItem(k);
        continue;
      }
      let save: PendingSave;
      try {
        save = JSON.parse(raw) as PendingSave;
      } catch (e) {
        // Corrupt blob — log and drop so we don't loop forever.
        Sentry.captureException(e);
        await AsyncStorage.removeItem(k);
        continue;
      }
      const result = await attemptSaveWithRetry(save);
      if (result.ok) {
        await AsyncStorage.removeItem(k);
        flushed++;
      } else {
        Sentry.captureException(
          result.error instanceof Error
            ? result.error
            : new Error(`pendingSync flush failed: ${safeStringify(result.error)}`)
        );
        remaining++;
      }
    }
  } catch (e) {
    Sentry.captureException(e);
  }
  return { flushed, remaining };
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
