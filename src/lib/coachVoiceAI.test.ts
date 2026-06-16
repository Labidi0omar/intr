// Tests for the AI rephrasing layer. The AI itself is non-deterministic, so
// the SAFETY MECHANISMS are what we cover here: the validator's rule set
// (the only thing standing between an inventing model and the user's
// coach card), the no-journals payload invariant, the fallback paths on
// network failure / empty response / cache hit, and the deterministic-only
// behavior when the COACH_AI_VOICE switch is off.

// ── Mocks ───────────────────────────────────────────────────────────────

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
      setItem: jest.fn((k: string, v: string) => {
        store[k] = v;
        return Promise.resolve();
      }),
      removeItem: jest.fn((k: string) => {
        delete store[k];
        return Promise.resolve();
      }),
      __store: store,
    },
  };
});

const mockInvoke = jest.fn();
jest.mock('./supabase', () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => mockInvoke(...args) } },
}));

// Feature flag is read at import time — re-mocked per test where needed.
let aiVoiceOn = true;
jest.mock('../constants/buildInfo', () => ({
  get COACH_AI_VOICE() { return aiVoiceOn; },
  BUILD_TAG: 'test',
}));

jest.mock('./errorReporting', () => ({
  reportSilent: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  allowedNumbersFor,
  buildEdgePayload,
  phraseObservationsAI,
  runCoachVoiceUpgrade,
  validatePhrasing,
} from './coachVoiceAI';
import { phraseObservation } from './coachVoice';
import type { Observation } from './coachObservations';

const asyncStore = (AsyncStorage as any).__store as Record<string, string>;
const TODAY = '2026-06-10';

beforeEach(() => {
  for (const k of Object.keys(asyncStore)) delete asyncStore[k];
  mockInvoke.mockReset();
  aiVoiceOn = true;
});

// ── Fixture builders ────────────────────────────────────────────────────

function upObs(lift = 'Bench', from = 80, to = 85, span = 3): Observation {
  return {
    type: 'lift_progression',
    subtype: 'up',
    id: `lift_progression:${lift}`,
    factSig: `up-${to}`,
    salience: 0.9,
    eventDate: TODAY,
    lift,
    from,
    to,
    span,
  };
}

function prObs(lift = 'Bench', newKg = 82.5, prevKg = 80): Observation {
  return {
    type: 'session_pr',
    id: `session_pr:${lift}`,
    factSig: `pr-${newKg}`,
    salience: 0.9,
    eventDate: TODAY,
    lift,
    newKg,
    prevKg,
  };
}

function effortObs(band: 'high' | 'low', pct = 0.7): Observation {
  return {
    type: 'effort_zone',
    id: 'effort_zone',
    factSig: band === 'high' ? 'effort-high' : 'effort-low',
    salience: 0.5,
    eventDate: TODAY,
    band,
    pct,
  };
}

function blockObs(blockWeek: 3 | 4): Observation {
  return {
    type: 'block_position',
    id: `block_position:${blockWeek}`,
    factSig: `block-${blockWeek}`,
    salience: 0.4,
    eventDate: TODAY,
    blockWeek,
  };
}

function rationaleObs(split: string, trainingDays: number): Observation {
  return {
    type: 'plan_rationale',
    id: `plan_rationale:${split}`,
    factSig: `rationale-${split}`,
    salience: 0.55,
    eventDate: TODAY,
    split,
    trainingDays,
  };
}

function calibrationObs(): Observation {
  return {
    type: 'calibration',
    id: 'calibration',
    factSig: 'calibration',
    salience: 0.6,
    eventDate: TODAY,
  };
}

// ── allowedNumbersFor ───────────────────────────────────────────────────

describe('allowedNumbersFor', () => {
  it('covers from/to/span for a lift-up observation', () => {
    const s = allowedNumbersFor(upObs('Bench', 80, 85, 3));
    expect(s.has('80')).toBe(true);
    expect(s.has('85')).toBe(true);
    expect(s.has('3')).toBe(true);
    expect(s.has('90')).toBe(false);
  });

  it('covers newKg/prevKg for a session PR — decimal forms preserved', () => {
    const s = allowedNumbersFor(prObs('Bench', 82.5, 80));
    expect(s.has('82.5')).toBe(true);
    expect(s.has('80')).toBe(true);
  });

  it('includes block_position blockWeek AND the constant 4 (for "Week N of 4")', () => {
    const s = allowedNumbersFor(blockObs(3));
    expect(s.has('3')).toBe(true);
    expect(s.has('4')).toBe(true);
  });

  it('includes pct-as-int AND the 1/2 RIR-band constants for effort_zone', () => {
    const s = allowedNumbersFor(effortObs('high', 0.7));
    expect(s.has('70')).toBe(true);
    expect(s.has('1')).toBe(true);
    expect(s.has('2')).toBe(true);
  });

  it('plan_rationale: includes trainingDays AND the constant 2 (for "twice a week" / "2x")', () => {
    const s = allowedNumbersFor(rationaleObs('ppl', 3));
    expect(s.has('3')).toBe(true);
    expect(s.has('2')).toBe(true);
  });

  it('calibration: allows only the window constants 2 and 14', () => {
    const s = allowedNumbersFor(calibrationObs());
    expect(s.has('2')).toBe(true);
    expect(s.has('14')).toBe(true);
    expect(s.has('5')).toBe(false);
  });
});

// ── validatePhrasing ────────────────────────────────────────────────────

describe('validatePhrasing', () => {
  const obs = upObs('Bench', 80, 85, 3);
  const det = phraseObservation(obs);

  it('accepts a clean rephrase that uses only allowed numbers', () => {
    const ai = 'Bench inching up — 80 to 85 kg over 3 sessions.';
    expect(validatePhrasing(ai, obs, det)).toBe(ai);
  });

  it('rejects an invented number ("up to 90 kg" when to=85) → fallback', () => {
    const ai = 'Bench up to 90 kg.';
    expect(validatePhrasing(ai, obs, det)).toBe(det);
  });

  it('rejects an invented delta ("up by 5 kg" when {from,to,span}={80,85,3})', () => {
    // 5 is NOT span (span=3) and NOT a weight. It IS an invented delta.
    const ai = 'Bench up by 5 kg this block.';
    expect(validatePhrasing(ai, obs, det)).toBe(det);
  });

  it('rejects emoji', () => {
    const ai = 'Bench up 🔥 80 to 85 over 3.';
    expect(validatePhrasing(ai, obs, det)).toBe(det);
  });

  it('rejects exclamation marks (no cheerleading)', () => {
    const ai = 'Bench up 80 to 85 over 3 sessions!';
    expect(validatePhrasing(ai, obs, det)).toBe(det);
  });

  it('rejects > 160 chars', () => {
    const ai = 'Bench '.padEnd(170, 'x'); // no numbers but very long
    expect(validatePhrasing(ai, obs, det)).toBe(det);
  });

  it('rejects empty / whitespace / null / non-string', () => {
    expect(validatePhrasing('', obs, det)).toBe(det);
    expect(validatePhrasing('   ', obs, det)).toBe(det);
    expect(validatePhrasing(null, obs, det)).toBe(det);
    expect(validatePhrasing(undefined, obs, det)).toBe(det);
    expect(validatePhrasing(42 as unknown as string, obs, det)).toBe(det);
  });

  it('accepts a no-number rephrase (the digit guard is permissive when there are no digits)', () => {
    const ezObs = effortObs('low', 0.2);
    const det2 = phraseObservation(ezObs);
    const ai = 'Loads are too easy — climb.';
    expect(validatePhrasing(ai, ezObs, det2)).toBe(ai);
  });
});

// ── buildEdgePayload + the no-journal invariant ─────────────────────────

describe('buildEdgePayload — no journal fields', () => {
  it('shape is closed: only factSig / observationType / facts / deterministicLine per entry', () => {
    const payload = buildEdgePayload([upObs(), prObs(), effortObs('high')]);
    expect(Object.keys(payload)).toEqual(['observations']);
    for (const entry of payload.observations) {
      expect(Object.keys(entry).sort()).toEqual([
        'deterministicLine',
        'factSig',
        'facts',
        'observationType',
      ]);
    }
  });

  it('facts contains numbers + lift name only — no journal/notes/text fields anywhere', () => {
    // Belt-and-braces: serialize the whole payload and grep for any key that
    // could plausibly carry free-text from a journal. The buildEdgePayload
    // surface is closed-shape — this catches a future refactor that
    // accidentally widens it.
    const payload = buildEdgePayload([
      upObs(),
      prObs(),
      blockObs(3),
      effortObs('low'),
      rationaleObs('ppl', 3),
      calibrationObs(),
    ]);
    const serialized = JSON.stringify(payload);
    for (const banned of ['journal', 'notes', 'reflection', 'user_text', 'mood', 'free_text']) {
      expect(serialized.toLowerCase()).not.toContain(banned);
    }
  });

  it('plan_rationale facts carry the enum split label and numeric trainingDays only', () => {
    const payload = buildEdgePayload([rationaleObs('upper_lower', 2)]);
    const entry = payload.observations[0];
    expect(entry.facts).toEqual({ split: 'upper_lower', trainingDays: 2 });
  });

  it('calibration facts are empty (no numbers, no free-text)', () => {
    const payload = buildEdgePayload([calibrationObs()]);
    expect(payload.observations[0].facts).toEqual({});
  });

  it('uses phraseObservation for the deterministicLine (single source of truth)', () => {
    const obs = upObs('Bench', 80, 85, 3);
    const payload = buildEdgePayload([obs]);
    expect(payload.observations[0].deterministicLine).toBe(phraseObservation(obs));
  });
});

// ── phraseObservationsAI ────────────────────────────────────────────────

describe('phraseObservationsAI', () => {
  it('returns an empty map for an empty input — no network call', async () => {
    const map = await phraseObservationsAI([]);
    expect(map.size).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('returns deterministic lines for every obs when the function errors', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const obs = upObs();
    const map = await phraseObservationsAI([obs]);
    expect(map.get(obs.factSig)).toBe(phraseObservation(obs));
  });

  it('returns deterministic lines when the function throws', async () => {
    mockInvoke.mockRejectedValue(new Error('network down'));
    const obs = upObs();
    const map = await phraseObservationsAI([obs]);
    expect(map.get(obs.factSig)).toBe(phraseObservation(obs));
  });

  it('returns deterministic lines on empty phrasings response', async () => {
    mockInvoke.mockResolvedValue({ data: { phrasings: {} }, error: null });
    const obs = upObs();
    const map = await phraseObservationsAI([obs]);
    expect(map.get(obs.factSig)).toBe(phraseObservation(obs));
  });

  it('returns deterministic line when the AI line invents a number', async () => {
    mockInvoke.mockResolvedValue({
      data: { phrasings: { [upObs().factSig]: 'Bench up to 90 kg.' } },
      error: null,
    });
    const obs = upObs();
    const map = await phraseObservationsAI([obs]);
    expect(map.get(obs.factSig)).toBe(phraseObservation(obs));
  });

  it('accepts and caches a clean AI line; cache hit skips the next invoke', async () => {
    const obs = upObs('Bench', 80, 85, 3);
    const clean = 'Bench inching up — 80 to 85 kg over 3 sessions.';
    mockInvoke.mockResolvedValue({
      data: { phrasings: { [obs.factSig]: clean } },
      error: null,
    });

    const first = await phraseObservationsAI([obs]);
    expect(first.get(obs.factSig)).toBe(clean);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Same factSig the next call: served from cache, no invoke.
    mockInvoke.mockClear();
    const second = await phraseObservationsAI([obs]);
    expect(second.get(obs.factSig)).toBe(clean);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('only batches uncached observations to the function', async () => {
    const cachedObs = upObs('Bench', 80, 85, 3);
    const freshObs = prObs('Squat', 100, 95);
    const cachedLine = 'Bench inching up — 80 to 85 kg over 3 sessions.';
    asyncStore[`coachVoiceAI:${cachedObs.factSig}`] = cachedLine;

    mockInvoke.mockResolvedValue({
      data: { phrasings: { [freshObs.factSig]: 'Squat PR: 100 kg, was 95.' } },
      error: null,
    });

    await phraseObservationsAI([cachedObs, freshObs]);
    // Function was called with ONLY the uncached obs.
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [, opts] = mockInvoke.mock.calls[0];
    expect(opts.body.observations).toHaveLength(1);
    expect(opts.body.observations[0].factSig).toBe(freshObs.factSig);
  });

  it('does NOT cache when the AI line was rejected (so a future model fix can land)', async () => {
    const obs = upObs();
    mockInvoke.mockResolvedValue({
      data: { phrasings: { [obs.factSig]: 'Bench up to 90 kg.' } },
      error: null,
    });
    await phraseObservationsAI([obs]);
    expect(asyncStore[`coachVoiceAI:${obs.factSig}`]).toBeUndefined();
  });
});

// ── runCoachVoiceUpgrade ────────────────────────────────────────────────

describe('runCoachVoiceUpgrade', () => {
  it('is a no-op when COACH_AI_VOICE is off (deterministic path untouched)', async () => {
    aiVoiceOn = false;
    const updateFn = jest.fn();
    await runCoachVoiceUpgrade('u', [upObs()], updateFn);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('is a no-op when the observation list is empty', async () => {
    const updateFn = jest.fn();
    await runCoachVoiceUpgrade('u', [], updateFn);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('calls updateFn only when the AI line differs from deterministic', async () => {
    const obs1 = upObs('Bench', 80, 85, 3); // AI wins
    const obs2 = prObs('Squat', 100, 95);    // AI rejected → no update
    mockInvoke.mockResolvedValue({
      data: {
        phrasings: {
          [obs1.factSig]: 'Bench inching up — 80 to 85 kg over 3 sessions.',
          [obs2.factSig]: 'Squat PR! 100 kg.', // exclamation → rejected
        },
      },
      error: null,
    });
    const updateFn = jest.fn().mockResolvedValue(undefined);

    await runCoachVoiceUpgrade('u', [obs1, obs2], updateFn);

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledWith('u', obs1.factSig, 'Bench inching up — 80 to 85 kg over 3 sessions.');
  });

  it('swallows updateFn rejections — never throws to the caller', async () => {
    const obs = upObs();
    mockInvoke.mockResolvedValue({
      data: { phrasings: { [obs.factSig]: 'Bench inching up — 80 to 85 kg over 3 sessions.' } },
      error: null,
    });
    const updateFn = jest.fn().mockRejectedValue(new Error('disk full'));
    await expect(runCoachVoiceUpgrade('u', [obs], updateFn)).resolves.toBeUndefined();
  });
});
