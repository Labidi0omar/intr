/// <reference types="node" />
// Coach-recap tests.
//
// We can't run the live Anthropic call (no ANTHROPIC_API_KEY in CI), so we
// verify by STRUCTURE:
//   1. buildCoachRecapContext — the pure context builder produces the right
//      shape from in-scope state (per-lift trend, target zone, deload,
//      cold-start, low-energy-trained).
//   2. buildFallbackRecap — the deterministic fallback walks the same
//      salience hierarchy the AI prompt does. Every priority tier has a
//      test.
//   3. requestCoachRecap — payload shape unchanged; silent-failure path
//      still returns { kind: 'error' } without throwing.
//   4. The fallback is what the client surfaces when the API errors, so
//      we exercise the "error → fallback" path at the unit level.
//
// The edge function (prompt + Anthropic call) is verified by code review
// and a manual smoke test against a live deploy; no fake integration here.

// supabase.ts transitively requires react-native (not transformed under ts-jest).
let mockInvoke: jest.Mock;

jest.mock('./supabase', () => {
  const invoke = jest.fn();
  return { supabase: { functions: { invoke } } };
});

// AsyncStorage is needed for the appendCoachMessage integration test below.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
      setItem: jest.fn((k: string, v: string) => { store[k] = v; return Promise.resolve(); }),
      removeItem: jest.fn((k: string) => { delete store[k]; return Promise.resolve(); }),
      __store: store,
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import {
  buildCoachRecapContext,
  buildFallbackRecap,
  produceRecapMessage,
  requestCoachRecap,
  withTimeout,
  type BuildCoachRecapContextArgs,
  type CoachRecapContext,
} from './coachRecap';
import { appendCoachMessage, loadCoachMessages } from './coachMessages';

beforeEach(() => {
  mockInvoke = (supabase as any).functions.invoke as jest.Mock;
  mockInvoke.mockReset();
  // Clear the AsyncStorage stub between tests so the message store starts
  // empty for each finishWorkout integration test.
  const store = (AsyncStorage as any).__store as Record<string, string>;
  for (const k of Object.keys(store)) delete store[k];
});

const TODAY = '2026-06-08';

// Fixture: a session a returning user might log on a normal day.
const sampleArgs: BuildCoachRecapContextArgs = {
  todayStr: TODAY,
  workoutType: 'Push',
  planDayDeload: false,
  todayLogs: [
    { exercise_name: 'Bench Press', weight_kg: 82.5, reps: '6-8', rir: 1 },
    { exercise_name: 'Overhead Press', weight_kg: 55, reps: '6-8', rir: 2 },
    { exercise_name: 'Tricep Pushdown', weight_kg: 25, reps: '10-12', rir: 2 },
  ],
  prs: [],
  energyScore: 4,
  streak: 3,
  blockWeek: 2,
  lastWeights: {
    'Bench Press':     { weight: 80, date: '2026-06-01', rir: 2 },
    'Overhead Press':  { weight: 55, date: '2026-06-01', rir: 1 },
    'Tricep Pushdown': { weight: 25, date: '2026-06-01', rir: 2 },
  },
  exerciseHistory: {
    'Bench Press': [
      { weight_kg: 80,   date: '2026-06-01', rir: 2 },
      { weight_kg: 77.5, date: '2026-05-25', rir: 1 },
      { weight_kg: 77.5, date: '2026-05-18', rir: 2 },
    ],
    'Overhead Press': [
      { weight_kg: 55, date: '2026-06-01', rir: 1 },
      { weight_kg: 55, date: '2026-05-25', rir: 2 },
    ],
    'Tricep Pushdown': [
      { weight_kg: 25, date: '2026-06-01', rir: 2 },
    ],
  },
};

// ── 1. Context builder ────────────────────────────────────────────────

describe('buildCoachRecapContext — shape', () => {
  it('passes today_logs, prs, energy, streak, blockWeek and workout_type through verbatim', () => {
    const ctx = buildCoachRecapContext(sampleArgs);
    expect(ctx.today_logs).toEqual(sampleArgs.todayLogs);
    expect(ctx.prs).toEqual([]);
    expect(ctx.energy_score).toBe(4);
    expect(ctx.streak).toBe(3);
    expect(ctx.block_week).toBe(2);
    expect(ctx.workout_type).toBe('Push');
    expect(ctx.deload).toBe(false);
  });

  it('builds per_lift_trend with up to 3 prior sessions per lift, newest first', () => {
    const ctx = buildCoachRecapContext(sampleArgs);
    expect(ctx.per_lift_trend).toHaveLength(3);
    const bench = ctx.per_lift_trend.find(t => t.name === 'Bench Press')!;
    expect(bench.recent.length).toBe(3);
    // Newest first → 80kg most recent, 77.5 next.
    expect(bench.recent[0]).toMatchObject({ weight_kg: 80, rir: 2 });
    expect(bench.recent[1]).toMatchObject({ weight_kg: 77.5, rir: 1 });
    // days_ago math: 2026-06-01 is 7 days before 2026-06-08.
    expect(bench.recent[0].days_ago).toBe(7);
  });

  it('excludes today and future-dated rows from per_lift_trend', () => {
    // Add a same-day row to history; it must not appear in per_lift_trend.
    const args: BuildCoachRecapContextArgs = {
      ...sampleArgs,
      exerciseHistory: {
        ...sampleArgs.exerciseHistory,
        'Bench Press': [
          { weight_kg: 82.5, date: TODAY, rir: 1 },  // today — exclude
          ...sampleArgs.exerciseHistory['Bench Press'],
        ],
      },
    };
    const ctx = buildCoachRecapContext(args);
    const bench = ctx.per_lift_trend.find(t => t.name === 'Bench Press')!;
    // Today's row is dropped; the 80kg prior session is still index 0.
    expect(bench.recent[0]).toMatchObject({ weight_kg: 80, days_ago: 7 });
  });

  it('target_zone_hit fires when at least one set is RIR 1 or 2', () => {
    expect(buildCoachRecapContext(sampleArgs).target_zone_hit).toBe(true);
    // Strip all RIRs → no target zone hit.
    const noRir: BuildCoachRecapContextArgs = {
      ...sampleArgs,
      todayLogs: sampleArgs.todayLogs.map(l => ({ ...l, rir: null })),
    };
    expect(buildCoachRecapContext(noRir).target_zone_hit).toBe(false);
    // RIR=0 (failure) doesn't count as target zone.
    const allFailed: BuildCoachRecapContextArgs = {
      ...sampleArgs,
      todayLogs: sampleArgs.todayLogs.map(l => ({ ...l, rir: 0 })),
    };
    expect(buildCoachRecapContext(allFailed).target_zone_hit).toBe(false);
  });

  it('deload reflects planDayDeload', () => {
    expect(buildCoachRecapContext({ ...sampleArgs, planDayDeload: true }).deload).toBe(true);
    expect(buildCoachRecapContext({ ...sampleArgs, planDayDeload: undefined }).deload).toBe(false);
  });

  it('trained_despite_low_energy fires only when energy ≤ 2 AND there are logs', () => {
    expect(buildCoachRecapContext({ ...sampleArgs, energyScore: 2 }).trained_despite_low_energy).toBe(true);
    expect(buildCoachRecapContext({ ...sampleArgs, energyScore: 1 }).trained_despite_low_energy).toBe(true);
    expect(buildCoachRecapContext({ ...sampleArgs, energyScore: 3 }).trained_despite_low_energy).toBe(false);
    // No logs → not "trained" despite anything.
    expect(buildCoachRecapContext({ ...sampleArgs, energyScore: 1, todayLogs: [] }).trained_despite_low_energy).toBe(false);
  });

  it('cold_start: false when at least one lift has prior history', () => {
    expect(buildCoachRecapContext(sampleArgs).cold_start).toBe(false);
  });

  it('cold_start: true when every lift has zero prior history', () => {
    const firstSession: BuildCoachRecapContextArgs = {
      ...sampleArgs,
      exerciseHistory: {},
      lastWeights: {},
    };
    expect(buildCoachRecapContext(firstSession).cold_start).toBe(true);
  });

  it('cold_start: true on an empty today_logs (defensive)', () => {
    expect(buildCoachRecapContext({ ...sampleArgs, todayLogs: [] }).cold_start).toBe(true);
  });

  it('vs_last_session: picks the biggest weight delta and tail-tags by RIR', () => {
    // sampleArgs: Bench up 80→82.5 with RIR 1 → 'clean lockout'.
    expect(buildCoachRecapContext(sampleArgs).vs_last_session)
      .toBe('bench press 80→82.5kg, clean lockout');
  });
});

// ── 2. Fallback — salience hierarchy ───────────────────────────────────

function ctxBase(): CoachRecapContext {
  // A baseline returning-user context. Each test mutates the field that
  // triggers its salience tier so the priority order is provable.
  return {
    today_logs: [
      { exercise_name: 'Bench Press', weight_kg: 80, reps: '6-8', rir: 3 },
      { exercise_name: 'Overhead Press', weight_kg: 55, reps: '6-8', rir: 3 },
    ],
    prs: [],
    energy_score: 4,
    streak: 3,
    block_week: 2,
    vs_last_session: '',
    workout_type: 'Push',
    per_lift_trend: [
      { name: 'Bench Press', recent: [{ weight_kg: 80, rir: 2, days_ago: 7 }] },
      { name: 'Overhead Press', recent: [{ weight_kg: 55, rir: 2, days_ago: 7 }] },
    ],
    target_zone_hit: false,
    deload: false,
    trained_despite_low_energy: false,
    cold_start: false,
  };
}

describe('buildFallbackRecap — salience hierarchy', () => {
  it('priority 1: PR wins over everything else', () => {
    const ctx = ctxBase();
    ctx.prs = ['Bench Press'];
    ctx.today_logs[0].weight_kg = 82.5;
    // Loud everything else — must still pick PR.
    ctx.target_zone_hit = true;
    ctx.trained_despite_low_energy = true;
    ctx.streak = 7;
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/PR on bench press/);
    expect(out).toMatch(/82\.5 kg/);
  });

  it('priority 2: progressed lift (today_weight > prior weight)', () => {
    const ctx = ctxBase();
    ctx.today_logs[0].weight_kg = 82.5; // up from 80
    // Suppress lower tiers.
    ctx.target_zone_hit = false;
    ctx.trained_despite_low_energy = false;
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/Bench Press up to 82\.5 kg from 80 kg/);
    expect(out).not.toMatch(/PR/);
  });

  it('priority 3: target zone hit (no PR, no progression)', () => {
    const ctx = ctxBase();
    ctx.target_zone_hit = true;
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/Push done/);
    expect(out).toMatch(/RIR 1.{1,2}2 zone/); // matches "RIR 1–2 zone" or "RIR 1-2 zone"
  });

  it('priority 4: trained despite low energy (no PR, no progression, no target hit)', () => {
    const ctx = ctxBase();
    ctx.energy_score = 1;
    ctx.trained_despite_low_energy = true;
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/Low-energy day/);
    expect(out).toMatch(/2 lifts/);
  });

  it('priority 5: streak milestone (5/7/10/14/21/30/50/100)', () => {
    const ctx = ctxBase();
    ctx.streak = 7;
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/Day 7 of the streak/);
  });

  it('priority 5: a non-milestone streak (e.g. 4 days) does NOT fire', () => {
    const ctx = ctxBase();
    ctx.streak = 4;
    const out = buildFallbackRecap(ctx);
    expect(out).not.toMatch(/Day 4 of the streak/);
  });

  it('priority 6 default: specific observation when nothing notable triggers', () => {
    const ctx = ctxBase();
    // Default fallback — workout type + top lift + count.
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/Push done/);
    expect(out).toMatch(/2 lifts/);
    expect(out).toMatch(/bench press at 80 kg/);
  });
});

// ── 3. Fallback — cold start and deload ────────────────────────────────

describe('buildFallbackRecap — cold start and deload', () => {
  it('cold start short-circuits everything else with "first one logged"', () => {
    const ctx = ctxBase();
    ctx.cold_start = true;
    // Even a PR and a milestone streak must not override the cold-start
    // line — the user has no trajectory yet for us to reflect on.
    ctx.prs = ['Bench Press'];
    ctx.streak = 7;
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/first time on these lifts/i);
    expect(out).toMatch(/track your progress/i);
    expect(out).not.toMatch(/PR on/);
  });

  it('cold start with zero logs: distinct "first one logged" copy', () => {
    const ctx = ctxBase();
    ctx.cold_start = true;
    ctx.today_logs = [];
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/First one logged/);
  });

  it('deload week: no progression celebration, frames as recovery', () => {
    const ctx = ctxBase();
    ctx.deload = true;
    // Even if the user's PRs/progression fields look loud, deload wins
    // the frame after cold-start.
    ctx.today_logs[0].weight_kg = 50; // would be "progressed" in tier 2
    const out = buildFallbackRecap(ctx);
    expect(out).toMatch(/Deload week/);
    expect(out).not.toMatch(/PR/);
    expect(out).not.toMatch(/up to/);
  });
});

// ── 4. Fallback — every branch returns a non-empty string ──────────────

describe('buildFallbackRecap — always non-empty', () => {
  it('returns a non-empty string for every salience tier', () => {
    const cases: Array<(c: CoachRecapContext) => void> = [
      c => { c.cold_start = true; },
      c => { c.deload = true; },
      c => { c.prs = ['Bench Press']; },
      c => { c.today_logs[0].weight_kg = 82.5; },
      c => { c.target_zone_hit = true; },
      c => { c.trained_despite_low_energy = true; c.energy_score = 2; },
      c => { c.streak = 14; },
      _ => { /* default branch */ },
    ];
    for (const mutate of cases) {
      const c = ctxBase();
      mutate(c);
      const out = buildFallbackRecap(c);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(10);
    }
  });
});

// ── 5. Request payload + silent failure (existing contract) ────────────

describe('requestCoachRecap — request payload shape', () => {
  it('invokes "coach-recap" with the full enriched context as the body', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { message: 'ok.' }, error: null });
    const ctx = buildCoachRecapContext(sampleArgs);
    await requestCoachRecap(ctx);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [fnName, opts] = mockInvoke.mock.calls[0];
    expect(fnName).toBe('coach-recap');
    // Every enriched field must be on the wire so the edge function and
    // the system prompt have what they need.
    expect(opts.body.today_logs).toEqual(sampleArgs.todayLogs);
    expect(opts.body.workout_type).toBe('Push');
    expect(opts.body.per_lift_trend).toBeDefined();
    expect(opts.body.target_zone_hit).toBe(true);
    expect(opts.body.deload).toBe(false);
    expect(opts.body.trained_despite_low_energy).toBe(false);
    expect(opts.body.cold_start).toBe(false);
  });

  it('parses an ok response as { kind: "ok", message }', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { message: 'Strong week 3.' }, error: null });
    const r = await requestCoachRecap(buildCoachRecapContext(sampleArgs));
    expect(r).toEqual({ kind: 'ok', message: 'Strong week 3.' });
  });
});

describe('requestCoachRecap — silent failure (still always non-throwing)', () => {
  const cases: Array<[string, () => void]> = [
    ['supabase error',     () => { mockInvoke.mockResolvedValueOnce({ data: null, error: { message: 'http 502' } }); }],
    ['SDK throws',         () => { mockInvoke.mockRejectedValueOnce(new Error('network down')); }],
    ['data is null',       () => { mockInvoke.mockResolvedValueOnce({ data: null, error: null }); }],
    ['message missing',    () => { mockInvoke.mockResolvedValueOnce({ data: { other: 1 }, error: null }); }],
    ['message whitespace', () => { mockInvoke.mockResolvedValueOnce({ data: { message: '   ' }, error: null }); }],
    ['message non-string', () => { mockInvoke.mockResolvedValueOnce({ data: { message: 42 }, error: null }); }],
  ];
  for (const [name, setup] of cases) {
    it(`returns { kind: "error" } and never throws when ${name}`, async () => {
      setup();
      const ctx = buildCoachRecapContext(sampleArgs);
      await expect(requestCoachRecap(ctx)).resolves.toEqual({ kind: 'error' });
    });
  }
});

// ── 6a. finishWorkout-shaped integration — appends on BOTH paths ───────
// Mirrors the exact lines in app/workout.tsx::finishWorkout:
//     const result  = await requestCoachRecap(ctx);
//     const message = produceRecapMessage(result, ctx);
//     await appendCoachMessage(user.id, { text: message, kind: 'recap' });
// We can't run the React component under ts-jest, but we can exercise the
// data flow directly and assert the persistent store ends up with a message
// on both AI-success and fallback paths.

describe('finishWorkout-shaped recap flow → appendCoachMessage', () => {
  it('AI-success path: message stored is the model response, not the fallback', async () => {
    const userId = 'user-ai';
    mockInvoke.mockResolvedValueOnce({
      data: { message: 'PR on bench — 82.5 kg. Trajectory is sharp.' },
      error: null,
    });

    const ctx = buildCoachRecapContext({ ...sampleArgs, prs: ['Bench Press'] });
    const result = await requestCoachRecap(ctx);
    const message = produceRecapMessage(result, ctx);
    await appendCoachMessage(userId, { text: message, kind: 'recap' });

    const stored = await loadCoachMessages(userId);
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('PR on bench — 82.5 kg. Trajectory is sharp.');
    expect(stored[0].seen).toBe(false);
    expect(stored[0].kind).toBe('recap');
    // Sanity: an unrelated fallback string is NOT what we stored.
    expect(stored[0].text).not.toMatch(/Cleanly logged/);
  });

  it('fallback path (API error): message stored is the deterministic fallback', async () => {
    const userId = 'user-fb';
    mockInvoke.mockResolvedValueOnce({ data: null, error: { message: 'http 502' } });

    const ctx = buildCoachRecapContext(sampleArgs);
    const result = await requestCoachRecap(ctx);
    expect(result.kind).toBe('error');

    const message = produceRecapMessage(result, ctx);
    await appendCoachMessage(userId, { text: message, kind: 'recap' });

    const stored = await loadCoachMessages(userId);
    expect(stored).toHaveLength(1);
    // sampleArgs has bench 80→82.5 — the "progressed" salience tier fires.
    expect(stored[0].text).toMatch(/Bench Press up to 82\.5 kg/);
    expect(stored[0].seen).toBe(false);
    expect(stored[0].kind).toBe('recap');
  });

  it('fallback path (timeout): message stored is still the deterministic fallback', async () => {
    const userId = 'user-timeout';
    mockInvoke.mockImplementation(
      () => new Promise(resolve => {
        const t = setTimeout(() => resolve({ data: { message: 'too late' }, error: null }), 500);
        (t as any).unref?.();
      })
    );
    const ctx = buildCoachRecapContext(sampleArgs);
    const result = await requestCoachRecap(ctx, { timeoutMs: 20 });
    expect(result.kind).toBe('error');
    const message = produceRecapMessage(result, ctx);
    await appendCoachMessage(userId, { text: message, kind: 'recap' });

    const stored = await loadCoachMessages(userId);
    expect(stored).toHaveLength(1);
    expect(stored[0].text).not.toMatch(/too late/); // model's reply discarded
  });
});

// ── 6. Fallback fires on error — the contract the client depends on ────

describe('requestCoachRecap error → buildFallbackRecap path', () => {
  it('caller gets { kind: "error" } and the fallback still produces a recap from the same ctx', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: { message: 'http 502' } });
    const ctx = buildCoachRecapContext(sampleArgs);
    const result = await requestCoachRecap(ctx);
    expect(result).toEqual({ kind: 'error' });
    // This is the line the client now runs on every error:
    //   const message = result.kind === 'ok' ? result.message : buildFallbackRecap(ctx);
    const message = buildFallbackRecap(ctx);
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(10);
    // sampleArgs: bench up from 80→82.5 → tier 2 ("progressed").
    expect(message).toMatch(/Bench Press up to 82\.5 kg/);
  });

  it('cold-start error path: fallback returns the "first one logged" copy', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('timeout'));
    const ctx = buildCoachRecapContext({
      ...sampleArgs,
      exerciseHistory: {},
      lastWeights: {},
      prs: [],
    });
    const r = await requestCoachRecap(ctx);
    expect(r).toEqual({ kind: 'error' });
    const message = buildFallbackRecap(ctx);
    expect(message).toMatch(/first time on these lifts/i);
  });
});

// ── 7. Timeout ─────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves with the inner value when it beats the timer', async () => {
    const v = await withTimeout(Promise.resolve('done'), 100);
    expect(v).toBe('done');
  });

  it('resolves with a __timeout sentinel when the inner work outlasts the timer', async () => {
    const slow = new Promise<string>(resolve => {
      const t = setTimeout(() => resolve('late'), 1000);
      (t as any).unref?.();
    });
    const v = await withTimeout(slow, 20);
    expect(v).toEqual({ __timeout: true });
  });
});

describe('requestCoachRecap — timeout', () => {
  it('returns { kind: "error" } when invoke takes longer than the timeout', async () => {
    mockInvoke.mockImplementation(
      () => new Promise(resolve => {
        const t = setTimeout(() => resolve({ data: { message: 'late' }, error: null }), 500);
        (t as any).unref?.();
      })
    );
    const r = await requestCoachRecap(buildCoachRecapContext(sampleArgs), { timeoutMs: 20 });
    expect(r).toEqual({ kind: 'error' });
  });
});
