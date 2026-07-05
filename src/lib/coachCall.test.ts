import { normalizeExName, shouldShowCoachCall } from './coachCall';

describe('normalizeExName', () => {
  it('lowercases', () => {
    expect(normalizeExName('Bench Press')).toBe('bench press');
    expect(normalizeExName('BENCH PRESS')).toBe('bench press');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeExName('  Squat  ')).toBe('squat');
    expect(normalizeExName('\tRow\n')).toBe('row');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeExName('Bench  Press')).toBe('bench press');
    expect(normalizeExName('Barbell  Bench   Press')).toBe('barbell bench press');
  });

  it('handles null / undefined / non-string as empty string', () => {
    expect(normalizeExName(null)).toBe('');
    expect(normalizeExName(undefined)).toBe('');
    // Cast — production callers pass strings, but the guard exists so a
    // bad shape doesn't NPE at read time.
    expect(normalizeExName(42 as unknown as string)).toBe('');
  });

  it('same input twice → same key (idempotent under normal use)', () => {
    // The whole point of the helper is that plan names and stored-map
    // names round-trip to the same key. Two slightly-different-looking
    // strings collapse to one identity.
    const a = normalizeExName('  Bench Press  ');
    const b = normalizeExName('bench  press');
    const c = normalizeExName('BENCH PRESS');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('shouldShowCoachCall', () => {
  // Minimal fixture. rx is `unknown | undefined` per the input contract —
  // the helper only cares whether it's defined, not what shape it has.
  const stubRx = { rationale: 'progress' } as unknown;

  // NOTE. Product change (see the file header): the Coach's Call hero now
  // renders on first-time exercises too. `historyLoad === 'ready'` is
  // what tells us we're SURE the user is a cold-starter — while
  // 'loading' or 'error' we still suppress so a cold message doesn't
  // flash and then get replaced by a real one when history lands.

  it('bodyweight ALWAYS suppresses — regardless of rx / lastKg / historyLoad', () => {
    // The only INTENDED suppression left. Bodyweight lifts have no
    // weight to prescribe; the form-cue coachHints line renders below.
    for (const historyLoad of ['loading', 'ready', 'error'] as const) {
      expect(
        shouldShowCoachCall({
          equipment: 'bodyweight',
          rx: stubRx,
          lastKg: 80,
          historyLoad,
        }),
      ).toBe(false);
      // Casing / whitespace on the equipment tag still counts.
      expect(
        shouldShowCoachCall({
          equipment: '  Bodyweight',
          rx: stubRx,
          lastKg: 80,
          historyLoad,
        }),
      ).toBe(false);
    }
  });

  it('ready + cold + non-bodyweight → show (first-timer hero fires)', () => {
    // Product change: the cold-start branch now renders the hero. The
    // caller decides between a starting-load seed hero and the bare
    // COPY_COLD_START copy — this guard just says "yes, render."
    expect(
      shouldShowCoachCall({
        equipment: 'barbell',
        rx: undefined,
        lastKg: undefined,
        historyLoad: 'ready',
      }),
    ).toBe(true);
    // Zero lastKg is the same "no history" signal (weightLog fetch
    // returned nothing for this lift).
    expect(
      shouldShowCoachCall({
        equipment: 'barbell',
        rx: undefined,
        lastKg: 0,
        historyLoad: 'ready',
      }),
    ).toBe(true);
  });

  it('loading + cold → suppress (no flash of cold copy)', () => {
    // The reliability fix's whole point. We don't KNOW yet whether the
    // user is a cold-starter — the exercise_logs fetch hasn't landed.
    // Suppress so a cold message doesn't render for a beat and then get
    // replaced by a real prescription once history arrives.
    expect(
      shouldShowCoachCall({
        equipment: 'barbell',
        rx: undefined,
        lastKg: undefined,
        historyLoad: 'loading',
      }),
    ).toBe(false);
  });

  it('error + cold → suppress (fetch outage — don\'t claim cold-start)', () => {
    // After the single retry has failed, `historyLoad` flips to 'error'
    // and a distinct Sentry tag fires one layer up. We keep the hero
    // suppressed here — it might genuinely be a first-timer, or the
    // fetch might just be down; we can't honestly say which.
    expect(
      shouldShowCoachCall({
        equipment: 'barbell',
        rx: undefined,
        lastKg: undefined,
        historyLoad: 'error',
      }),
    ).toBe(false);
  });

  it('rx present → show, regardless of historyLoad', () => {
    // If the engine produced a prescription, some upstream lookup found
    // a weight — trust it even if the batch fetch is still in flight
    // or errored. Rare in practice (the memo depends on lastWeights)
    // but the guard should still say yes.
    for (const historyLoad of ['loading', 'ready', 'error'] as const) {
      expect(
        shouldShowCoachCall({
          equipment: 'barbell',
          rx: stubRx,
          lastKg: undefined,
          historyLoad,
        }),
      ).toBe(true);
    }
  });

  it('lastKg present → show, regardless of historyLoad', () => {
    // History exists for this lift (e.g. the on-demand swap fetch just
    // merged a row) even if the initial batch load is still in flight
    // or errored. The hero is safe to render.
    for (const historyLoad of ['loading', 'ready', 'error'] as const) {
      expect(
        shouldShowCoachCall({
          equipment: 'barbell',
          rx: undefined,
          lastKg: 80,
          historyLoad,
        }),
      ).toBe(true);
    }
  });

  it('swapped-in name after on-demand merge → show', () => {
    // Simulates the "B" fix path: user swaps in a lift with no entry in
    // the batch-fetched lastWeights, the on-demand fetch resolves and
    // merges a row for it, next render passes lastKg. The hero recovers.
    expect(
      shouldShowCoachCall({
        equipment: 'barbell',
        rx: undefined,
        lastKg: 100,
        historyLoad: 'ready',
      }),
    ).toBe(true);
  });

  it('null equipment (missing tag on a plan row) is treated as non-bodyweight', () => {
    expect(
      shouldShowCoachCall({
        equipment: null,
        rx: stubRx,
        lastKg: 80,
        historyLoad: 'ready',
      }),
    ).toBe(true);
  });
});
