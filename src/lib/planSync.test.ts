/// <reference types="node" />
// Tests for ensureCurrentWeekPlan's profile-recovery behavior.
//
// Background: the function used to bail (and return null) whenever
// profiles.training_days was missing. That bricked accounts whose
// training_days got nulled out but still had preferred_split set — the
// home screen showed "building your week" forever. The function now
// derives training_days from preferred_split when possible, and only
// gives up when both fields are missing.

// Sentry needs mocking — the real RN package can't load in node.
jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// notifications.ts pulls in expo-constants + react-native Platform; stub the
// whole module since these tests don't care about scheduling.
jest.mock('../utils/notifications', () => ({
  syncWorkoutNotifications: jest.fn(() => Promise.resolve()),
}));

// AsyncStorage stub — minimal in-memory KV.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
      setItem: jest.fn((k: string, v: string) => { store[k] = v; return Promise.resolve(); }),
      removeItem: jest.fn((k: string) => { delete store[k]; return Promise.resolve(); }),
      // Tests share one in-memory store across the file; clear it per-test so
      // the profile-inputs cache (written by some paths) can't leak between
      // cases and flip a cache-fallback assertion.
      clear: jest.fn(() => { for (const k of Object.keys(store)) delete store[k]; return Promise.resolve(); }),
    },
  };
});

// Chainable supabase mock. Every query-builder method returns `this` and
// resolves either via `.maybeSingle()` (used for single-row reads) or via
// `.then()` (everything else: lists, upserts, updates, deletes). Tests enqueue
// responses by `${table}:${op}[:maybeSingle]`. Unspecified slots resolve to a
// benign default so we only have to wire the cases the test actually cares
// about.
jest.mock('./supabase', () => {
  const queues: Record<string, { data: any; error: any }[]> = {};
  const calls: { table: string; op: string; args: any[]; terminal: string }[] = [];
  const getUser = jest.fn();

  const builder = (table: string) => {
    let op = '';
    let opArgs: any[] = [];
    const b: any = {};
    b.select = (...a: any[]) => { op = 'select'; opArgs = a; return b; };
    b.insert = (...a: any[]) => { op = 'insert'; opArgs = a; return b; };
    b.update = (...a: any[]) => { op = 'update'; opArgs = a; return b; };
    b.upsert = (...a: any[]) => { op = 'upsert'; opArgs = a; return b; };
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
      calls.push({ table, op, args: opArgs, terminal: 'maybeSingle' });
      const r = queues[k]?.shift() ?? { data: null, error: null };
      return Promise.resolve(r);
    };
    b.then = (onF: any, onR: any) => {
      const k = `${table}:${op}`;
      calls.push({ table, op, args: opArgs, terminal: 'then' });
      const r = queues[k]?.shift() ?? { data: [], error: null };
      return Promise.resolve(r).then(onF, onR);
    };
    return b;
  };

  const supabase: any = {
    auth: { getUser },
    from: jest.fn((t: string) => builder(t)),
  };
  supabase.__mock = {
    enqueue: (k: string, r: { data: any; error: any }) => { (queues[k] ||= []).push(r); },
    reset: () => {
      for (const k of Object.keys(queues)) delete queues[k];
      calls.length = 0;
      getUser.mockReset();
      (supabase.from as jest.Mock).mockClear();
    },
    calls,
    getUser,
  };
  return { supabase };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { supabase } from './supabase';
import { ensureCurrentWeekPlan, readCachedProfileInputs } from './planSync';
import { CURRENT_PLAN_VERSION } from './planGeneration';
import { deriveCanonicalWeek } from '../utils/planCatchUp';

const mock = (supabase as any).__mock as {
  enqueue: (k: string, r: { data: any; error: any }) => void;
  reset: () => void;
  calls: { table: string; op: string; args: any[]; terminal: string }[];
  getUser: jest.Mock;
};

beforeEach(async () => {
  mock.reset();
  await (AsyncStorage as any).clear();
  (Sentry.captureException as jest.Mock).mockClear();
  (Sentry.captureMessage as jest.Mock).mockClear();
});

describe('ensureCurrentWeekPlan profile recovery', () => {
  it('derives training_days from preferred_split when training_days is null (bro_split → 5)', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-bro' } } });

    // Initial profile read: training_days missing, but split is set.
    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: null, preferred_split: 'bro_split', fitness_level: 'intermediate' },
      error: null,
    });
    // Profile backfill of training_days succeeds.
    mock.enqueue('profiles:update', { data: null, error: null });
    // No covering / future rows — survey returns empty.
    mock.enqueue('weekly_plans:select', { data: [], error: null });
    // Mesocycle anchor lookup (earliest weekly_plans row) — none exists, so
    // the function falls back to today.
    mock.enqueue('weekly_plans:select:maybeSingle', { data: null, error: null });
    // No prior weeks for variety history.
    mock.enqueue('weekly_plans:select', { data: [], error: null });
    // Four upserts (HORIZON_WEEKS = 4). All succeed.
    for (let i = 0; i < 4; i++) {
      mock.enqueue('weekly_plans:upsert', { data: null, error: null });
    }
    // Re-read of today's row after generation so the cache can be refreshed.
    // generatePlan emits one PlanDay per calendar day; the test only needs
    // a non-empty array so extractDays returns truthy.
    mock.enqueue('weekly_plans:select:maybeSingle', {
      data: { plan: [{ date: '2026-06-05', day_name: 'Friday', focus: 'Push', exercises: [] }] },
      error: null,
    });

    const result = await ensureCurrentWeekPlan();
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);

    // The backfill update fired against the profiles table.
    const profileUpdates = mock.calls.filter(c => c.table === 'profiles' && c.op === 'update');
    expect(profileUpdates.length).toBeGreaterThanOrEqual(1);
    // The first one is the training_days backfill with the derived value 5.
    expect(profileUpdates[0].args[0]).toEqual({ training_days: 5 });

    // Genuinely missing config → Sentry should NOT have fired.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('FORCE regen issues a single scoped delete of every future row (no marker filter)', async () => {
    // Earlier behavior preserved rows with plan.shifted === true. The
    // rigid-shift cascade that wrote those is gone (replaced by the
    // catch-up regen in app/(tabs)/home.tsx), so force-regen now wipes
    // the whole future unconditionally. Past rows survive (streak /
    // history reads still resolve).
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-force' } } });

    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: 3, preferred_split: 'ppl', fitness_level: 'intermediate' },
      error: null,
    });
    // The single force-delete (resolves via .then on .gte('week_start', today)).
    mock.enqueue('weekly_plans:delete', { data: null, error: null });
    // Survey + downstream regen reads with safe defaults.
    mock.enqueue('weekly_plans:select', { data: [], error: null });
    mock.enqueue('weekly_plans:select:maybeSingle', { data: null, error: null });
    mock.enqueue('weekly_plans:select', { data: [], error: null });
    for (let i = 0; i < 4; i++) mock.enqueue('weekly_plans:upsert', { data: null, error: null });
    mock.enqueue('weekly_plans:select:maybeSingle', { data: { plan: [] }, error: null });

    await ensureCurrentWeekPlan({ force: true });

    const deletes = mock.calls.filter(c => c.table === 'weekly_plans' && c.op === 'delete');
    // Exactly one delete is fired — the simple scoped delete.
    expect(deletes.length).toBe(1);
  });

  it('returns null and reports to Sentry when both training_days and preferred_split are null', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-empty' } } });
    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: null, preferred_split: null, fitness_level: 'intermediate' },
      error: null,
    });

    const result = await ensureCurrentWeekPlan();
    expect(result).toBeNull();

    // Sentry was notified so we can spot stuck accounts in prod.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect((Sentry.captureMessage as jest.Mock).mock.calls[0][0]).toMatch(/missing training_days and preferred_split/);

    // We did not attempt to write anything.
    expect(mock.calls.some(c => c.op === 'upsert' || c.op === 'update' || c.op === 'insert')).toBe(false);
  });
});

// ── preferred_split is the user's explicit choice ─────────────────────
// It used to be re-derived from training_days on every run, which silently
// clobbered a deliberate split/days mismatch the moment the user edited
// their schedule. Now it's only ever BACKFILLED when missing.

describe('ensureCurrentWeekPlan preferred_split handling', () => {
  // Enqueue the no-existing-rows generation path (no force): survey empty,
  // anchor null, variety empty, then 4 horizon upserts.
  const enqueueGenPath = () => {
    mock.enqueue('weekly_plans:select', { data: [], error: null });          // survey
    mock.enqueue('weekly_plans:select:maybeSingle', { data: null, error: null }); // anchor
    mock.enqueue('weekly_plans:select', { data: [], error: null });          // variety history
    for (let i = 0; i < 4; i++) mock.enqueue('weekly_plans:upsert', { data: null, error: null });
  };

  const splitUpdates = () =>
    mock.calls.filter(
      c => c.table === 'profiles' && c.op === 'update' && c.args[0] && 'preferred_split' in c.args[0],
    );

  it('does NOT overwrite an explicit preferred_split that mismatches the day count', async () => {
    // 3 days would DEFAULT to ppl, but the user explicitly chose bro_split.
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-keep-split' } } });
    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: 3, preferred_split: 'bro_split', fitness_level: 'intermediate' },
      error: null,
    });
    enqueueGenPath();

    await ensureCurrentWeekPlan();

    // The explicit pick survives — no preferred_split write at all.
    expect(splitUpdates()).toHaveLength(0);
  });

  it('BACKFILLS preferred_split only when it is missing (default from day count)', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-backfill-split' } } });
    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: 3, preferred_split: null, fitness_level: 'intermediate' },
      error: null,
    });
    enqueueGenPath();
    mock.enqueue('profiles:update', { data: null, error: null }); // the backfill write

    await ensureCurrentWeekPlan();

    const updates = splitUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toEqual({ preferred_split: 'ppl' }); // splitForDays(3)
  });
});

// ── Active-week self-heal ─────────────────────────────────────────────
// The stored active row is validated against generatePlan at the user's
// true position (completed non-recovery sessions before the week + block
// math). A corrupted row is regenerated on the next call — converging
// from any stored state with no manual data deletion. Scenario mirrors
// the real intr@gmail.com account: PPL/3-day anchored Mon 2026-05-18,
// 9 sessions completed before the active week (Jun 8), today Thu Jun 11,
// stored active row corrupted to a 2-day "Legs, Push" week.

describe('ensureCurrentWeekPlan active-week self-heal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 5, 11, 12, 0, 0)); // Thu 2026-06-11 local
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const pairs = (days: Array<{ date?: string; workoutType?: string }>) =>
    days
      .map(d => ({ date: d.date, workoutType: d.workoutType }))
      .sort((a, b) => (a.date! < b.date! ? -1 : 1));

  const CORRUPT_ROW = {
    week_start: '2026-06-08',
    plan: [
      { day: 'Thursday', date: '2026-06-11', workoutType: 'Legs', location: 'gym', muscleGroups: [], exercises: [] },
      { day: 'Saturday', date: '2026-06-13', workoutType: 'Push', location: 'gym', muscleGroups: [], exercises: [] },
    ],
    plan_version: CURRENT_PLAN_VERSION,
  };

  const enqueueProfile = () => {
    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: 3, preferred_split: 'ppl', fitness_level: 'beginner' },
      error: null,
    });
  };

  it('a corrupted current-week row is regenerated at the true rotation position', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-heal' } } });
    enqueueProfile();
    // Survey: only the corrupted active row exists.
    mock.enqueue('weekly_plans:select', { data: [CORRUPT_ROW], error: null });
    // Mesocycle anchor: the account's earliest row, Mon 2026-05-18.
    mock.enqueue('weekly_plans:select:maybeSingle', { data: { week_start: '2026-05-18' }, error: null });
    // 9 completed non-recovery sessions before the active week.
    mock.enqueue('workout_sessions:select', { data: null, error: null, count: 9 } as any);
    // No variety history.
    mock.enqueue('weekly_plans:select', { data: [], error: null });

    const result = await ensureCurrentWeekPlan();
    expect(result).not.toBeNull();

    // The active week was healed in place: position 9 ≡ 0 → the canonical
    // Push Jun 8 / Pull Jun 10 / Legs Jun 12 week — a full PPL week, not
    // the stored 2-day "Legs, Push" collapse.
    expect(pairs(result!)).toEqual([
      { date: '2026-06-08', workoutType: 'Push' },
      { date: '2026-06-10', workoutType: 'Pull' },
      { date: '2026-06-12', workoutType: 'Legs' },
    ]);

    // It was persisted via upsert on the SAME week_start (no row deletion),
    // alongside the 3 missing future weeks.
    const upserts = mock.calls.filter(c => c.table === 'weekly_plans' && c.op === 'upsert');
    expect(upserts.length).toBe(4);
    expect(upserts[0].args[0].week_start).toBe('2026-06-08');
    expect(pairs(upserts[0].args[0].plan)).toEqual(pairs(result!));
    expect(mock.calls.some(c => c.table === 'weekly_plans' && c.op === 'delete')).toBe(false);

    // Future weeks continue the rotation correctly: position advances by
    // trainingDays per week (9+3=12 ≡ 0, …) → every future week is a
    // correctly-sequenced Push → Pull → Legs week.
    for (let i = 1; i < 4; i++) {
      const plan = upserts[i].args[0].plan as Array<{ date?: string; workoutType?: string }>;
      expect(pairs(plan).map(d => d.workoutType)).toEqual(['Push', 'Pull', 'Legs']);
    }
  });

  it('IDEMPOTENT: a canonical active row is left untouched (no writes, no drift)', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-heal-2' } } });
    enqueueProfile();
    // The active row already matches the canonical derivation (blockWeek 4:
    // Jun 8 is 3 weeks past the May 18 anchor → in-block week 4).
    const canonical = deriveCanonicalWeek({
      weekStartIso: '2026-06-08',
      completedBeforeWeek: 9,
      trainingDays: 3,
      fitnessLevel: 'beginner',
      location: 'gym',
      blockIndex: 0,
      blockWeek: 4,
    });
    mock.enqueue('weekly_plans:select', {
      data: [
        { week_start: '2026-06-08', plan: canonical, plan_version: CURRENT_PLAN_VERSION },
        { week_start: '2026-06-15', plan: [{ date: '2026-06-15', workoutType: 'Push', exercises: [] }], plan_version: CURRENT_PLAN_VERSION },
        { week_start: '2026-06-22', plan: [{ date: '2026-06-22', workoutType: 'Push', exercises: [] }], plan_version: CURRENT_PLAN_VERSION },
        { week_start: '2026-06-29', plan: [{ date: '2026-06-29', workoutType: 'Push', exercises: [] }], plan_version: CURRENT_PLAN_VERSION },
      ],
      error: null,
    });
    mock.enqueue('weekly_plans:select:maybeSingle', { data: { week_start: '2026-05-18' }, error: null });
    mock.enqueue('workout_sessions:select', { data: null, error: null, count: 9 } as any);

    const result = await ensureCurrentWeekPlan();
    expect(result).not.toBeNull();
    expect(pairs(result!)).toEqual(pairs(canonical));

    // Fully satisfied horizon → zero writes. Re-running cannot drift.
    expect(mock.calls.some(c => c.table === 'weekly_plans' && (c.op === 'upsert' || c.op === 'delete'))).toBe(false);
  });
});

// ── Offline profile-inputs cache fallback ─────────────────────────────
// Supabase is the source of truth; user:profileInputs is the read fallback
// (same model as plan:current). When the network profile read returns
// nothing for split/days/level, generation falls back to the cache; it only
// bails when BOTH network and cache are empty. A successful network read
// refreshes the cache so it's always last-known-good.
describe('ensureCurrentWeekPlan offline profile-inputs cache', () => {
  // No-existing-rows generation path (no force): survey empty, anchor null,
  // variety empty, then 4 horizon upserts, then the re-read for the cache.
  const enqueueGenPath = () => {
    mock.enqueue('weekly_plans:select', { data: [], error: null });               // survey
    mock.enqueue('weekly_plans:select:maybeSingle', { data: null, error: null }); // anchor
    mock.enqueue('weekly_plans:select', { data: [], error: null });               // variety history
    for (let i = 0; i < 4; i++) mock.enqueue('weekly_plans:upsert', { data: null, error: null });
    mock.enqueue('weekly_plans:select:maybeSingle', {
      data: { plan: [{ date: '2026-06-13', day: 'Saturday', workoutType: 'Push', exercises: [] }] },
      error: null,
    });
  };

  it('generates from cached inputs when the Supabase profile read is empty', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-offline' } } });
    // Last-known-good cache from a previous online session.
    await AsyncStorage.setItem(
      'user:profileInputs',
      JSON.stringify({ training_days: 3, preferred_split: 'ppl', fitness_level: 'intermediate' }),
    );
    // Network gives nothing (offline / transient miss).
    mock.enqueue('profiles:select:maybeSingle', { data: null, error: null });
    enqueueGenPath();

    const result = await ensureCurrentWeekPlan();

    // Generation succeeded from the cached inputs (ppl → 3 training days).
    expect(result).not.toBeNull();
    const upserts = mock.calls.filter(c => c.table === 'weekly_plans' && c.op === 'upsert');
    expect(upserts.length).toBe(4);
    const trainingDayCount = (upserts[0].args[0].plan as any[]).filter(d => d.workoutType !== 'Rest').length;
    expect(trainingDayCount).toBe(3);

    // It did NOT bail, and (offline) attempted no profile backfill writes.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(mock.calls.some(c => c.table === 'profiles' && c.op === 'update')).toBe(false);
  });

  it('still bails (and reports) when BOTH the network and the cache are empty', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-offline-empty' } } });
    // No cache seeded (cleared in beforeEach), network empty too.
    mock.enqueue('profiles:select:maybeSingle', { data: null, error: null });

    const result = await ensureCurrentWeekPlan();

    expect(result).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect((Sentry.captureMessage as jest.Mock).mock.calls[0][0]).toMatch(/missing training_days and preferred_split/);
    // Nothing was written.
    expect(mock.calls.some(c => c.op === 'upsert' || c.op === 'update' || c.op === 'insert')).toBe(false);
  });

  it('refreshes the cache after a successful network read (last-known-good)', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-refresh' } } });
    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: 4, preferred_split: 'upper_lower', fitness_level: 'advanced' },
      error: null,
    });
    enqueueGenPath();

    await ensureCurrentWeekPlan();

    const cached = await readCachedProfileInputs();
    expect(cached).toEqual({
      training_days: 4,
      preferred_split: 'upper_lower',
      fitness_level: 'advanced',
    });
  });

  it('does NOT overwrite an explicit network split even when the cache differs', async () => {
    mock.getUser.mockResolvedValue({ data: { user: { id: 'u-explicit' } } });
    // Stale cache says ppl, but the live network pick is bro_split.
    await AsyncStorage.setItem(
      'user:profileInputs',
      JSON.stringify({ training_days: 3, preferred_split: 'ppl', fitness_level: 'beginner' }),
    );
    mock.enqueue('profiles:select:maybeSingle', {
      data: { training_days: 3, preferred_split: 'bro_split', fitness_level: 'intermediate' },
      error: null,
    });
    enqueueGenPath();

    await ensureCurrentWeekPlan();

    // The explicit network split wins: no preferred_split write (never
    // overwritten), and the cache is refreshed to the network pick.
    const splitWrites = mock.calls.filter(
      c => c.table === 'profiles' && c.op === 'update' && c.args[0] && 'preferred_split' in c.args[0],
    );
    expect(splitWrites).toHaveLength(0);
    const cached = await readCachedProfileInputs();
    expect(cached?.preferred_split).toBe('bro_split');
  });
});
