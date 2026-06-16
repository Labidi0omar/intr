/// <reference types="node" />
// Tests for the finish-workout save queue.
//
// What we're covering:
//   1. attemptSaveWithRetry succeeds when the first attempt errors but the
//      second succeeds — the "fail once, recover" path.
//   2. attemptSaveWithRetry surfaces the last error when both attempts fail.
//   3. enqueuePendingSave → flushPendingSaves drains the key on success.
//   4. flushPendingSaves leaves the key in place AND reports to Sentry when
//      the queued blob still can't sync.
//   5. wasFresh is reported correctly so the workout_completed analytics
//      gate in finishWorkout stays honest.

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
      setItem: jest.fn((k: string, v: string) => { store[k] = v; return Promise.resolve(); }),
      removeItem: jest.fn((k: string) => { delete store[k]; return Promise.resolve(); }),
      getAllKeys: jest.fn(() => Promise.resolve(Object.keys(store))),
      // Test hook: clear the in-memory store between tests.
      __store: store,
    },
  };
});

// Chainable supabase mock — same pattern as planSync.test.ts. Every chain
// method returns `this` and resolves either through `.then` (default) or
// `.select()` after insert (treated as `.then` too — we capture both).
// Tests enqueue per-(table, op) responses; the rest default to {data:[], error:null}.
jest.mock('./supabase', () => {
  const queues: Record<string, { data: unknown; error: unknown }[]> = {};
  const calls: { table: string; op: string; terminal: string }[] = [];

  const builder = (table: string) => {
    let op = '';
    const b: any = {};
    b.select = (..._a: any[]) => { if (!op) op = 'select'; return b; };
    b.insert = (..._a: any[]) => { op = 'insert'; return b; };
    b.update = (..._a: any[]) => { op = 'update'; return b; };
    b.upsert = (..._a: any[]) => { op = 'upsert'; return b; };
    b.delete = () => { op = 'delete'; return b; };
    b.eq = () => b;
    b.gte = () => b;
    b.lt = () => b;
    b.lte = () => b;
    b.in = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = () => {
      const k = `${table}:${op}:maybeSingle`;
      calls.push({ table, op, terminal: 'maybeSingle' });
      const r = queues[k]?.shift() ?? { data: null, error: null };
      return Promise.resolve(r);
    };
    b.then = (onF: any, onR: any) => {
      const k = `${table}:${op}`;
      calls.push({ table, op, terminal: 'then' });
      const r = queues[k]?.shift() ?? { data: [], error: null };
      return Promise.resolve(r).then(onF, onR);
    };
    return b;
  };

  const supabase: any = { from: jest.fn((t: string) => builder(t)) };
  supabase.__mock = {
    enqueue: (k: string, r: { data: unknown; error: unknown }) => {
      (queues[k] ||= []).push(r);
    },
    reset: () => {
      for (const k of Object.keys(queues)) delete queues[k];
      calls.length = 0;
      (supabase.from as jest.Mock).mockClear();
    },
    calls,
  };
  return { supabase };
});

import * as Sentry from '@sentry/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import {
  attemptSave,
  attemptSaveWithRetry,
  clearPendingSave,
  enqueuePendingSave,
  flushPendingSaves,
  loadPendingSave,
  runDurableSave,
  runFinishPersistence,
  type PendingSave,
} from './pendingSync';

const mock = (supabase as any).__mock as {
  enqueue: (k: string, r: { data: unknown; error: unknown }) => void;
  reset: () => void;
  calls: { table: string; op: string; terminal: string }[];
};

const asyncStore = (AsyncStorage as any).__store as Record<string, string>;

function makeSave(userId = 'u1', date = '2026-06-08'): PendingSave {
  return {
    userId,
    plannedDate: date,
    session: {
      user_id: userId,
      planned_date: date,
      completed_at: '2026-06-08T18:00:00.000Z',
      workout_type: 'Push',
      location: 'gym',
      energy_level: 'normal',
      completed: true,
      exercises_done: [{ name: 'Bench Press', sets: 4 }],
      replanned: false,
    },
    logRows: [
      {
        user_id: userId,
        exercise_name: 'Bench Press',
        weight_kg: 82.5,
        logged_date: date,
        session_id: null,
        reps_in_reserve: 1,
      },
      {
        user_id: userId,
        exercise_name: 'Pull-up',
        weight_kg: 0,
        logged_date: date,
        session_id: null,
        reps_in_reserve: null,
      },
    ],
    queuedAt: '2026-06-08T18:00:01.000Z',
  };
}

beforeEach(() => {
  mock.reset();
  for (const k of Object.keys(asyncStore)) delete asyncStore[k];
  (Sentry.captureException as jest.Mock).mockClear();
  (Sentry.captureMessage as jest.Mock).mockClear();
});

// ── attemptSaveWithRetry ────────────────────────────────────────────────

describe('attemptSaveWithRetry', () => {
  it('recovers on the second attempt when the first errors mid-save', async () => {
    const save = makeSave();

    // Attempt 1:
    //   lookup → empty (no existing session)
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    //   insert → ERROR (this is where the legacy code lost data silently)
    mock.enqueue('workout_sessions:insert', { data: null, error: { message: 'http 500' } });

    // Attempt 2:
    //   lookup → empty again (still nothing on the server)
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    //   insert → succeeds, returns the new session id
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-1' }], error: null });
    //   exercise_logs insert → succeeds
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    const r = await attemptSaveWithRetry(save);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sessionId).toBe('sess-1');
      expect(r.wasFresh).toBe(true);
    }
  });

  it('returns the last error when both attempts fail', async () => {
    const save = makeSave();
    // Both attempts: lookup ok, insert fails.
    for (let i = 0; i < 2; i++) {
      mock.enqueue('workout_sessions:select', { data: [], error: null });
      mock.enqueue('workout_sessions:insert', { data: null, error: { message: `attempt ${i + 1} failed` } });
    }
    const r = await attemptSaveWithRetry(save);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((r.error as { message: string }).message).toBe('attempt 2 failed');
    }
  });

  it('reports wasFresh=false when a workout_sessions row already exists', async () => {
    const save = makeSave();
    // Existing row → attemptSave updates instead of inserts.
    mock.enqueue('workout_sessions:select', { data: [{ id: 'sess-prev' }], error: null });
    mock.enqueue('workout_sessions:update', { data: null, error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    const r = await attemptSave(save);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wasFresh).toBe(false);
      expect(r.sessionId).toBe('sess-prev');
    }
  });

  it('returns error when exercise_logs insert fails even after the session row is saved', async () => {
    const save = makeSave();
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-1' }], error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: { message: 'logs blew up' } });

    const r = await attemptSave(save);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((r.error as { message: string }).message).toBe('logs blew up');
    }
  });
});

// ── enqueue / flush replay path ─────────────────────────────────────────

describe('enqueuePendingSave + flushPendingSaves', () => {
  it('flush drains a queued save when supabase now succeeds', async () => {
    const save = makeSave('u1', '2026-06-08');
    await enqueuePendingSave(save);

    // Key is present before flush.
    expect(await loadPendingSave('u1', '2026-06-08')).not.toBeNull();
    expect(Object.keys(asyncStore)).toContain('pendingWorkoutSave:u1:2026-06-08');

    // Flush replays: lookup empty, insert OK, logs OK.
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-replay' }], error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    const r = await flushPendingSaves();
    expect(r.flushed).toBe(1);
    expect(r.remaining).toBe(0);

    // Key cleared so we don't re-replay forever.
    expect(await loadPendingSave('u1', '2026-06-08')).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('flush leaves the key in place AND reports to Sentry when sync still fails', async () => {
    const save = makeSave('u1', '2026-06-08');
    await enqueuePendingSave(save);

    // attemptSaveWithRetry will burn 2 attempts; both fail.
    for (let i = 0; i < 2; i++) {
      mock.enqueue('workout_sessions:select', { data: [], error: null });
      mock.enqueue('workout_sessions:insert', { data: null, error: { message: 'still offline' } });
    }

    const r = await flushPendingSaves();
    expect(r.flushed).toBe(0);
    expect(r.remaining).toBe(1);

    // Critical: the data is still in AsyncStorage. We never lose it silently.
    const reloaded = await loadPendingSave('u1', '2026-06-08');
    expect(reloaded).not.toBeNull();
    expect(reloaded?.logRows[0].weight_kg).toBe(82.5);
    expect(reloaded?.logRows[0].reps_in_reserve).toBe(1);

    // And Sentry was notified so the failure is visible in prod.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('flush drops a corrupt blob and reports the parse error (no infinite loop)', async () => {
    asyncStore['pendingWorkoutSave:u1:2026-06-08'] = '{not valid json';

    const r = await flushPendingSaves();
    expect(r.flushed).toBe(0);
    expect(r.remaining).toBe(0);

    // Key removed so the next flush doesn't trip on it again.
    expect(asyncStore['pendingWorkoutSave:u1:2026-06-08']).toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('clearPendingSave removes the queued key for that (user, date)', async () => {
    const save = makeSave('u2', '2026-06-07');
    await enqueuePendingSave(save);
    expect(await loadPendingSave('u2', '2026-06-07')).not.toBeNull();
    await clearPendingSave('u2', '2026-06-07');
    expect(await loadPendingSave('u2', '2026-06-07')).toBeNull();
  });
});

// ── End-to-end: failure → queue → replay ────────────────────────────────

describe('finish-workout failure → queue → replay', () => {
  it('a hard save failure preserves weights/RIR and a later flush syncs them', async () => {
    const save = makeSave('u1', '2026-06-08');

    // 1. finishWorkout's attemptSaveWithRetry runs (2 attempts), both fail.
    for (let i = 0; i < 2; i++) {
      mock.enqueue('workout_sessions:select', { data: [], error: null });
      mock.enqueue('workout_sessions:insert', { data: null, error: { message: 'offline' } });
    }
    const firstResult = await attemptSaveWithRetry(save);
    expect(firstResult.ok).toBe(false);

    // 2. finishWorkout queues the blob (the production code does this when
    //    the result is not ok). We assert weights + RIR are preserved.
    await enqueuePendingSave(save);
    const queued = await loadPendingSave('u1', '2026-06-08');
    expect(queued?.logRows.find(r => r.exercise_name === 'Bench Press')).toMatchObject({
      weight_kg: 82.5,
      reps_in_reserve: 1,
    });

    // 3. Next launch — flushPendingSaves runs; this time Supabase is up.
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-final' }], error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    const r = await flushPendingSaves();
    expect(r.flushed).toBe(1);
    expect(r.remaining).toBe(0);
    expect(await loadPendingSave('u1', '2026-06-08')).toBeNull();
  });
});

// ── runDurableSave ──────────────────────────────────────────────────────

describe('runDurableSave', () => {
  it('returns ok and does NOT enqueue when the network write succeeds', async () => {
    const save = makeSave();
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-1' }], error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    const r = await runDurableSave(save);
    expect(r).toMatchObject({ ok: true, sessionId: 'sess-1', wasFresh: true, enqueued: false });
    // No pendingWorkoutSave key was written.
    expect(asyncStore['pendingWorkoutSave:u1:2026-06-08']).toBeUndefined();
  });

  it('enqueues the save (weights + RIR intact) when the network write fails', async () => {
    const save = makeSave();
    // Both attempts (original + retry) fail.
    for (let i = 0; i < 2; i++) {
      mock.enqueue('workout_sessions:select', { data: [], error: null });
      mock.enqueue('workout_sessions:insert', { data: null, error: { message: 'offline' } });
    }

    const r = await runDurableSave(save);
    expect(r).toMatchObject({ ok: false, enqueued: true });

    // The queued blob carries the original weights + RIR exactly as built.
    const reloaded = await loadPendingSave('u1', '2026-06-08');
    expect(reloaded).not.toBeNull();
    expect(reloaded?.logRows.find(r => r.exercise_name === 'Bench Press')).toMatchObject({
      weight_kg: 82.5,
      reps_in_reserve: 1,
    });
  });
});

// ── runFinishPersistence — the regression scenario ──────────────────────
// The bug being guarded: the PR-detection fetch (fetchPriorLogs) used to
// run BEFORE the save. Offline it threw, the outer try/catch aborted, and
// the save never executed. The workout was lost instead of queued.
//
// runFinishPersistence flips the order: save first, then fetchPriorLogs
// inside its own try/catch. A throw from fetchPriorLogs MUST NOT undo or
// prevent the save.

describe('runFinishPersistence', () => {
  it('REGRESSION: when the PR fetch rejects AND the network is offline, the save is still enqueued', async () => {
    const save = makeSave();
    // Network save fails twice (simulating offline).
    for (let i = 0; i < 2; i++) {
      mock.enqueue('workout_sessions:select', { data: [], error: null });
      mock.enqueue('workout_sessions:insert', { data: null, error: { message: 'offline' } });
    }
    // The PR fetch ALSO rejects — what used to abort the whole flow.
    const fetchPriorLogs = jest.fn().mockRejectedValueOnce(new Error('network: prior log read failed'));

    const r = await runFinishPersistence(save, { fetchPriorLogs });

    // The save was attempted, failed, and queued — weights + RIR intact.
    expect(r.saveOk).toBe(false);
    expect(r.enqueued).toBe(true);
    expect(r.priorLogs).toEqual([]);
    expect(r.priorLogsError).toBeInstanceOf(Error);

    const reloaded = await loadPendingSave('u1', '2026-06-08');
    expect(reloaded).not.toBeNull();
    expect(reloaded?.logRows.find(r => r.exercise_name === 'Bench Press')).toMatchObject({
      weight_kg: 82.5,
      reps_in_reserve: 1,
    });
    expect(fetchPriorLogs).toHaveBeenCalledTimes(1);
  });

  it('save succeeds and PR fetch rejects → save is persisted, priorLogs empty (NOT undone)', async () => {
    const save = makeSave();
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-7' }], error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    const fetchPriorLogs = jest.fn().mockRejectedValueOnce(new Error('flaky network'));

    const r = await runFinishPersistence(save, { fetchPriorLogs });
    expect(r.saveOk).toBe(true);
    expect(r.sessionId).toBe('sess-7');
    expect(r.enqueued).toBe(false);
    expect(r.priorLogs).toEqual([]);
    expect(r.priorLogsError).toBeInstanceOf(Error);
    // No queue blob was written — save went through the network path.
    expect(asyncStore['pendingWorkoutSave:u1:2026-06-08']).toBeUndefined();
  });

  it('happy path: save succeeds, PR fetch returns prior logs', async () => {
    const save = makeSave();
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-9' }], error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    const fetchPriorLogs = jest.fn().mockResolvedValueOnce([
      { exercise_name: 'Bench Press', weight_kg: 80 },
    ]);

    const r = await runFinishPersistence(save, { fetchPriorLogs });
    expect(r.saveOk).toBe(true);
    expect(r.priorLogs).toEqual([{ exercise_name: 'Bench Press', weight_kg: 80 }]);
    expect(r.priorLogsError).toBeUndefined();
  });

  it('save runs BEFORE fetchPriorLogs — call order is observable', async () => {
    // The strongest assertion of the contract: the save's network calls
    // happen first, then fetchPriorLogs. Verify by interleaving timing.
    const save = makeSave();
    mock.enqueue('workout_sessions:select', { data: [], error: null });
    mock.enqueue('workout_sessions:insert', { data: [{ id: 'sess-12' }], error: null });
    mock.enqueue('exercise_logs:insert', { data: null, error: null });

    let fetchPriorCalledAt = -1;
    const fetchPriorLogs = jest.fn().mockImplementation(async () => {
      fetchPriorCalledAt = mock.calls.length;
      return [];
    });

    await runFinishPersistence(save, { fetchPriorLogs });

    // mock.calls contains every supabase chain terminal. The save makes
    // three (select → insert(session) → insert(logs)). fetchPriorLogs must
    // not have fired until ALL three landed.
    expect(fetchPriorCalledAt).toBeGreaterThanOrEqual(3);
  });
});
