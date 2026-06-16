/// <reference types="node" />
// Tests for the coach-message store.
//
// Covers:
//   - append prepends newest-first and caps at MAX_MESSAGES.
//   - load returns [] on missing or corrupt storage.
//   - markCoachMessagesSeen sets every entry's seen flag.
//   - latestUnseen returns the most recent unseen or null.
//   - Dedup: appending the same text+createdAt twice is a no-op.

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
      // Expose the underlying store so tests can poke at it directly
      // (e.g. to write a corrupt blob).
      __store: store,
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MAX_MESSAGES,
  appendCoachMessage,
  appendCoachMessageOnce,
  latestUnseen,
  loadCoachMessages,
  markCoachMessagesSeen,
  updateCoachMessageTextByFactSig,
  type CoachMessage,
} from './coachMessages';

const asyncStore = (AsyncStorage as any).__store as Record<string, string>;

beforeEach(() => {
  for (const k of Object.keys(asyncStore)) delete asyncStore[k];
});

// ── load ─────────────────────────────────────────────────────────────────

describe('loadCoachMessages', () => {
  it('returns [] for a user with no stored messages', async () => {
    expect(await loadCoachMessages('u-empty')).toEqual([]);
  });

  it('returns [] (does not throw) on a corrupt JSON blob', async () => {
    asyncStore['coachMessages:u-corrupt'] = '{not valid';
    await expect(loadCoachMessages('u-corrupt')).resolves.toEqual([]);
  });

  it('drops malformed entries from a partially-valid blob', async () => {
    asyncStore['coachMessages:u'] = JSON.stringify([
      { id: 'a', text: 'good', createdAt: '2026-06-08T00:00:00.000Z', seen: false, kind: 'recap' },
      { id: 'b', text: 42, createdAt: '2026-06-08T00:00:00.000Z', seen: false, kind: 'recap' }, // text not string
      { id: 'c', text: 'no kind', createdAt: '2026-06-08T00:00:00.000Z', seen: false, kind: 'unknown' }, // bad kind
    ]);
    const msgs = await loadCoachMessages('u');
    expect(msgs.map(m => m.id)).toEqual(['a']);
  });
});

// ── append ──────────────────────────────────────────────────────────────

describe('appendCoachMessage', () => {
  it('stores the first message with seen=false and kind=recap by default', async () => {
    const list = await appendCoachMessage('u', { text: 'Bench up 80→82.5 kg.' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      text: 'Bench up 80→82.5 kg.',
      seen: false,
      kind: 'recap',
    });
    // The store is persisted, not just returned — a fresh load matches.
    const reloaded = await loadCoachMessages('u');
    expect(reloaded).toEqual(list);
  });

  it('prepends — newest message is at index 0', async () => {
    await appendCoachMessage('u', { text: 'first', createdAt: '2026-06-01T00:00:00.000Z', id: 'a' });
    await appendCoachMessage('u', { text: 'second', createdAt: '2026-06-02T00:00:00.000Z', id: 'b' });
    await appendCoachMessage('u', { text: 'third', createdAt: '2026-06-03T00:00:00.000Z', id: 'c' });
    const msgs = await loadCoachMessages('u');
    expect(msgs.map(m => m.text)).toEqual(['third', 'second', 'first']);
  });

  it('caps the list at MAX_MESSAGES (oldest drops off the tail)', async () => {
    for (let i = 0; i < MAX_MESSAGES + 3; i++) {
      await appendCoachMessage('u', {
        text: `msg-${i}`,
        // Distinct createdAt so dedup doesn't suppress any append.
        createdAt: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        id: `id-${i}`,
      });
    }
    const msgs = await loadCoachMessages('u');
    expect(msgs).toHaveLength(MAX_MESSAGES);
    // The 3 oldest (msg-0, msg-1, msg-2) fell off; latest (msg-10) is head.
    expect(msgs[0].text).toBe(`msg-${MAX_MESSAGES + 2}`);
    expect(msgs[msgs.length - 1].text).toBe('msg-3');
  });

  it('dedups when the head already matches the same text + createdAt', async () => {
    await appendCoachMessage('u', { text: 'same', createdAt: '2026-06-08T00:00:00.000Z' });
    const after = await appendCoachMessage('u', { text: 'same', createdAt: '2026-06-08T00:00:00.000Z' });
    expect(after).toHaveLength(1);
  });

  it('keeps per-user lists isolated', async () => {
    await appendCoachMessage('u1', { text: 'a' });
    await appendCoachMessage('u2', { text: 'b' });
    expect((await loadCoachMessages('u1')).map(m => m.text)).toEqual(['a']);
    expect((await loadCoachMessages('u2')).map(m => m.text)).toEqual(['b']);
  });

  it('does not store an empty/whitespace text', async () => {
    await appendCoachMessage('u', { text: '   ' });
    expect(await loadCoachMessages('u')).toEqual([]);
  });
});

// ── markCoachMessagesSeen ───────────────────────────────────────────────

describe('markCoachMessagesSeen', () => {
  it('flips every message to seen=true', async () => {
    await appendCoachMessage('u', { text: 'a' });
    await appendCoachMessage('u', { text: 'b' });
    expect((await loadCoachMessages('u')).every(m => m.seen === false)).toBe(true);
    await markCoachMessagesSeen('u');
    expect((await loadCoachMessages('u')).every(m => m.seen === true)).toBe(true);
  });

  it('is a no-op when nothing is unseen (does not rewrite the blob)', async () => {
    await appendCoachMessage('u', { text: 'a' });
    await markCoachMessagesSeen('u');
    const setItem = (AsyncStorage as any).setItem as jest.Mock;
    setItem.mockClear();
    await markCoachMessagesSeen('u');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no messages', async () => {
    const setItem = (AsyncStorage as any).setItem as jest.Mock;
    setItem.mockClear();
    await markCoachMessagesSeen('u-empty');
    expect(setItem).not.toHaveBeenCalled();
  });
});

// ── latestUnseen ────────────────────────────────────────────────────────

describe('latestUnseen', () => {
  it('returns the head unseen message', () => {
    const msgs: CoachMessage[] = [
      { id: 'a', text: 'newest', createdAt: 't1', seen: false, kind: 'recap' },
      { id: 'b', text: 'older',  createdAt: 't0', seen: true,  kind: 'recap' },
    ];
    expect(latestUnseen(msgs)?.id).toBe('a');
  });

  it('skips seen entries to find the next unseen one', () => {
    const msgs: CoachMessage[] = [
      { id: 'a', text: 'seen', createdAt: 't2', seen: true,  kind: 'recap' },
      { id: 'b', text: 'unseen', createdAt: 't1', seen: false, kind: 'recap' },
      { id: 'c', text: 'seen too', createdAt: 't0', seen: true, kind: 'recap' },
    ];
    expect(latestUnseen(msgs)?.id).toBe('b');
  });

  it('returns null when every message is seen', () => {
    const msgs: CoachMessage[] = [
      { id: 'a', text: 'one', createdAt: 't0', seen: true, kind: 'recap' },
    ];
    expect(latestUnseen(msgs)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(latestUnseen([])).toBeNull();
  });
});

// ── appendCoachMessageOnce ──────────────────────────────────────────────
// Idempotency by key. The pre-workout readiness narration is the canonical
// use case: handleStartWorkout may fire multiple times in a day (user
// backs out of the active phase and re-Starts), but the coach card should
// only carry one readiness entry per day. Key shape is `kind:yyyy-mm-dd`.

describe('appendCoachMessageOnce', () => {
  it('first call with a key stores the message with the dedupKey persisted', async () => {
    const list = await appendCoachMessageOnce('u', 'readiness:2026-06-08', {
      text: "Energy's low — conservative today.",
      kind: 'autoreg',
    });
    expect(list).toHaveLength(1);
    expect(list[0].dedupKey).toBe('readiness:2026-06-08');
    expect(list[0].kind).toBe('autoreg');
    // Persisted on disk, not just returned.
    const reloaded = await loadCoachMessages('u');
    expect(reloaded[0].dedupKey).toBe('readiness:2026-06-08');
  });

  it('second call with the SAME key is a no-op — no duplicate stored', async () => {
    await appendCoachMessageOnce('u', 'readiness:2026-06-08', {
      text: "Energy's low — conservative today.",
      kind: 'autoreg',
    });
    await appendCoachMessageOnce('u', 'readiness:2026-06-08', {
      text: "Energy's low — DIFFERENT TEXT.",
      kind: 'autoreg',
    });
    const stored = await loadCoachMessages('u');
    expect(stored).toHaveLength(1);
    // Original text wins — the second call didn't overwrite either.
    expect(stored[0].text).toBe("Energy's low — conservative today.");
  });

  it('different keys do NOT collide — one per (kind, day)', async () => {
    await appendCoachMessageOnce('u', 'readiness:2026-06-08', {
      text: 'day 1 readiness', kind: 'autoreg',
    });
    await appendCoachMessageOnce('u', 'readiness:2026-06-09', {
      text: 'day 2 readiness', kind: 'autoreg',
    });
    const stored = await loadCoachMessages('u');
    expect(stored).toHaveLength(2);
    // Newest first.
    expect(stored.map(m => m.text)).toEqual(['day 2 readiness', 'day 1 readiness']);
  });

  it('idempotent across kinds: an autoreg key does NOT block a recap append', async () => {
    await appendCoachMessageOnce('u', 'readiness:2026-06-08', {
      text: 'pre-workout autoreg', kind: 'autoreg',
    });
    // The recap append uses its own (or no) key — should land normally.
    await appendCoachMessage('u', { text: 'post-workout recap', kind: 'recap' });
    const stored = await loadCoachMessages('u');
    expect(stored).toHaveLength(2);
    expect(stored[0].kind).toBe('recap');
    expect(stored[1].kind).toBe('autoreg');
  });

  it('the seen flag on the dedup hit is preserved (re-Start does NOT re-mark unseen)', async () => {
    await appendCoachMessageOnce('u', 'readiness:2026-06-08', {
      text: 'readiness', kind: 'autoreg',
    });
    await markCoachMessagesSeen('u');
    // Same key fires again — must NOT flip seen back to false.
    await appendCoachMessageOnce('u', 'readiness:2026-06-08', {
      text: 'readiness', kind: 'autoreg',
    });
    const stored = await loadCoachMessages('u');
    expect(stored).toHaveLength(1);
    expect(stored[0].seen).toBe(true);
  });
});

// ── New deterministic kinds round-trip ──────────────────────────────────
//
// Regression guard for the validator inside loadCoachMessages: when a new
// CoachMessageKind is added to the type union, the kind must also be added
// to the load-side allowlist. Without this test, a save→load round-trip
// silently filters the message out and it vanishes on the next focus.

describe('new kinds (briefing / deload / pr / streak)', () => {
  it('round-trips a briefing message through append → load', async () => {
    await appendCoachMessage('u', {
      text: "Today's Push day — 5 lifts.",
      kind: 'briefing',
    });
    const stored = await loadCoachMessages('u');
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe('briefing');
    expect(stored[0].text).toBe("Today's Push day — 5 lifts.");
  });

  it.each(['briefing', 'deload', 'pr', 'streak'] as const)(
    '%s survives the load-time validator (legacy kinds — old blobs still load)',
    async kind => {
      await appendCoachMessage('u', { text: `hello ${kind}`, kind });
      const stored = await loadCoachMessages('u');
      expect(stored).toHaveLength(1);
      expect(stored[0].kind).toBe(kind);
    },
  );

  it("round-trips the new 'observation' kind through append → load", async () => {
    await appendCoachMessage('u', {
      text: 'Bench up 3 sessions: 80 to 85 kg.',
      kind: 'observation',
    });
    const stored = await loadCoachMessages('u');
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe('observation');
    expect(stored[0].text).toBe('Bench up 3 sessions: 80 to 85 kg.');
  });

  it('appendCoachMessageOnce + observation kind survives reload with its dedupKey', async () => {
    await appendCoachMessageOnce('u', 'obs:lift_progression:Bench:up-85', {
      text: 'Bench up.',
      kind: 'observation',
    });
    const reloaded = await loadCoachMessages('u');
    expect(reloaded[0].dedupKey).toBe('obs:lift_progression:Bench:up-85');
    expect(reloaded[0].kind).toBe('observation');
  });

  it("a fresh rest-day message takes the [0] slot over a prior day's training briefing", async () => {
    // Yesterday's training briefing landed in the store (kind 'observation',
    // the canonical write path used by the dashboard).
    await appendCoachMessageOnce('u', 'obs:briefing_fallback:brief-2026-06-09', {
      text: "Today's a Legs day — 6 exercises on the board.",
      kind: 'observation',
    });
    // Today is a rest day → the rest-day observation is appended. Its per-day
    // dedupKey differs, so it is NOT suppressed and prepends ahead of the
    // stale briefing. The card renders [0], so the rest line now wins.
    await appendCoachMessageOnce('u', 'obs:rest_day:rest-2026-06-10', {
      text: 'Rest day — take it. If you feel like moving, you still can.',
      kind: 'observation',
    });
    const stored = await loadCoachMessages('u');
    expect(stored[0].dedupKey).toBe('obs:rest_day:rest-2026-06-10');
    expect(stored[0].text).toMatch(/Rest day/);
    // The stale briefing is still present, just no longer the top slot.
    expect(stored[1].text).toMatch(/on the board/);
  });
});

// ── updateCoachMessageTextByFactSig ─────────────────────────────────────
//
// The AI voice upgrade calls this after a successful rephrase: locate the
// stored message by factSig (the trailing segment of the dedupKey) and
// rewrite its text. Critically, `seen` is preserved — we do NOT want a
// model that returns ~800ms after the user viewed the card to re-light the
// "new" dot.

describe('updateCoachMessageTextByFactSig', () => {
  it('rewrites the text of the matching message and leaves everything else alone', async () => {
    await appendCoachMessageOnce('u', 'obs:lift_progression:Bench:up-85', {
      text: 'Bench up 3 sessions: 80 to 85 kg.',
      kind: 'observation',
    });
    await markCoachMessagesSeen('u');

    await updateCoachMessageTextByFactSig('u', 'up-85', 'Bench inching up — 80 to 85 kg.');

    const stored = await loadCoachMessages('u');
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('Bench inching up — 80 to 85 kg.');
    expect(stored[0].seen).toBe(true); // preserved
    expect(stored[0].dedupKey).toBe('obs:lift_progression:Bench:up-85');
    expect(stored[0].kind).toBe('observation');
  });

  it('no-op when no message matches the factSig', async () => {
    await appendCoachMessage('u', { text: 'unrelated', kind: 'recap' });
    await updateCoachMessageTextByFactSig('u', 'up-85', 'should not apply');
    const stored = await loadCoachMessages('u');
    expect(stored[0].text).toBe('unrelated');
  });

  it('no-op on empty newText / empty factSig', async () => {
    await appendCoachMessageOnce('u', 'obs:lift_progression:Bench:up-85', {
      text: 'Bench up 3 sessions.',
      kind: 'observation',
    });
    await updateCoachMessageTextByFactSig('u', 'up-85', '   ');
    await updateCoachMessageTextByFactSig('u', '', 'something');
    const stored = await loadCoachMessages('u');
    expect(stored[0].text).toBe('Bench up 3 sessions.');
  });
});
