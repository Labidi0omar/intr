// Spies for supabase + AsyncStorage that we can assert never get called when
// the __DEV__ guard fires. These mocks are declared BEFORE the import of
// devSeed.ts because jest hoists jest.mock calls to the top of the file.

const supabaseDeleteSpy = jest.fn();
const supabaseUpdateSpy = jest.fn();
const supabaseUpsertSpy = jest.fn();
const supabaseInsertSpy = jest.fn();
const supabaseFromSpy = jest.fn();
const asyncStorageMultiRemoveSpy = jest.fn(() => Promise.resolve());
const asyncStorageSetItemSpy = jest.fn(() => Promise.resolve());
const asyncStorageRemoveItemSpy = jest.fn(() => Promise.resolve());

// notifications.ts imports expo-constants (an ESM module ts-jest can't
// transform). devSeed -> planSync -> notifications, so we stub the
// notification surface — none of it is exercised by the guard tests.
jest.mock('../utils/notifications', () => ({
  syncWorkoutNotifications: jest.fn(() => Promise.resolve()),
  scheduleComebackNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: asyncStorageSetItemSpy,
    removeItem: asyncStorageRemoveItemSpy,
    multiRemove: asyncStorageMultiRemoveSpy,
    // getAllKeys is called by wipeAsyncStorage BEFORE multiRemove; returning
    // an empty list keeps the (would-be) wipe path cleanly observable —
    // multiRemove must STILL be uncalled in the guarded path because we
    // return before wipeAsyncStorage even runs.
    getAllKeys: jest.fn(() => Promise.resolve([])),
  },
}));

jest.mock('./supabase', () => {
  // Chainable builder where every terminal records to the appropriate spy.
  // .delete()/.update()/.upsert()/.insert() are the only mutating verbs
  // devSeed uses; .from() is recorded too so a future caller that opens a
  // builder without ever calling a mutating verb still trips the assertion
  // (zero from() calls = zero touches).
  const builder = (table: string): any => {
    const b: any = {};
    b.select = () => b;
    b.delete = () => { supabaseDeleteSpy(table); return b; };
    b.update = () => { supabaseUpdateSpy(table); return b; };
    b.upsert = () => { supabaseUpsertSpy(table); return b; };
    b.insert = () => { supabaseInsertSpy(table); return b; };
    b.eq = () => b;
    b.gte = () => b;
    b.lt = () => b;
    b.lte = () => b;
    b.in = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = () => Promise.resolve({ data: null, error: null });
    b.then = (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return b;
  };
  return {
    supabase: {
      from: (t: string) => { supabaseFromSpy(t); return builder(t); },
      auth: {
        // Even auth.getUser() must NOT be called in the guarded path —
        // a release build refusing to touch any account-shaped read is
        // the whole point of the guard.
        getUser: jest.fn(() => Promise.resolve({ data: { user: { id: 'u' } }, error: null })),
      },
    },
  };
});

import {
  HISTORY_EXACT_KEYS,
  HISTORY_PREFIX_KEYS,
  PRESERVE_KEYS,
  pickHistoryKeysToWipe,
} from './devSeedKeys';
import { seedScenario, wipeToFreshAccount } from './devSeed';
import { supabase } from './supabase';

// These tests pin the WIPE INVENTORY. A contributor who adds a new
// history-derived AsyncStorage key needs to also list it here, otherwise
// the seeder leaves stale state across reseeds. The dedicated assertions
// below catch the common shapes the codebase already uses.

describe('AsyncStorage wipe inventory', () => {
  it('history-derived exact keys include the plan + profile-input caches', () => {
    expect(HISTORY_EXACT_KEYS).toContain('plan:current');
    expect(HISTORY_EXACT_KEYS).toContain('user:profileInputs');
  });

  it('history-derived prefixes cover every known per-user / per-date store', () => {
    const required = [
      'coachMessages:',
      'coachHero:pin:',
      'coachVoiceAI:',
      'gap:resolvedThrough:',
      'pendingWorkoutSave:',
      'intr_workout_',
      'coachRecap:',
      'intr:gapAck:',
      'intr:plan_ready_fired:',
      'recovery:unlocked:',
    ];
    for (const p of required) {
      expect(HISTORY_PREFIX_KEYS).toContain(p);
    }
  });

  it('preserve list excludes every history-wipe entry (no contradiction)', () => {
    for (const k of PRESERVE_KEYS) {
      expect(HISTORY_EXACT_KEYS).not.toContain(k);
      for (const p of HISTORY_PREFIX_KEYS) {
        expect(k.startsWith(p)).toBe(false);
      }
    }
  });

  it('preserve list pins device preferences (location, notification time)', () => {
    expect(PRESERVE_KEYS).toContain('user:defaultLocation');
    expect(PRESERVE_KEYS).toContain('intr_notification_time');
    expect(PRESERVE_KEYS).toContain('intr_notif_permission_asked');
    expect(PRESERVE_KEYS).toContain('intr:journal:migratedToSupabase');
  });
});

describe('pickHistoryKeysToWipe', () => {
  it('selects every history-derived key', () => {
    const allKeys = [
      'plan:current',
      'user:profileInputs',
      'coachMessages:abc',
      'coachHero:pin:abc',
      'coachVoiceAI:v2:fact-1',
      'coachVoiceAI:v3:fact-2',
      'gap:resolvedThrough:user-1',
      'pendingWorkoutSave:user-1:2026-06-22',
      'intr_workout_2026-06-22',
      'coachRecap:user-1:2026-06-22',
      'intr:gapAck:user-1:5:2026-06-22',
      'intr:plan_ready_fired:user-1',
      'recovery:unlocked:user-1',
      // Preserve list — must NOT appear in the wipe.
      'user:defaultLocation',
      'intr_notification_time',
      'intr_notif_permission_asked',
      'intr:journal:migratedToSupabase',
    ];
    const wiped = pickHistoryKeysToWipe(allKeys).sort();
    const expected = [
      'plan:current',
      'user:profileInputs',
      'coachMessages:abc',
      'coachHero:pin:abc',
      'coachVoiceAI:v2:fact-1',
      'coachVoiceAI:v3:fact-2',
      'gap:resolvedThrough:user-1',
      'pendingWorkoutSave:user-1:2026-06-22',
      'intr_workout_2026-06-22',
      'coachRecap:user-1:2026-06-22',
      'intr:gapAck:user-1:5:2026-06-22',
      'intr:plan_ready_fired:user-1',
      'recovery:unlocked:user-1',
    ].sort();
    expect(wiped).toEqual(expected);
  });

  it('leaves device-preference keys alone', () => {
    const allKeys = [
      'user:defaultLocation',
      'intr_notification_time',
      'intr_notif_permission_asked',
      'intr:journal:migratedToSupabase',
      // A journal entry (per-day) is also user data — currently NOT
      // history-derived per the wipe inventory; the seeder leaves it.
      'journal:2026-06-22',
    ];
    expect(pickHistoryKeysToWipe(allKeys)).toEqual([]);
  });

  it('returns an empty list for unrelated keys', () => {
    expect(pickHistoryKeysToWipe(['random_key', 'something:else'])).toEqual([]);
  });
});

// ── Defense-in-depth __DEV__ guard ────────────────────────────────────
//
// The dev menu is __DEV__-gated end-to-end, but the seeder itself is a
// destructive function — RLS-scoped deletes against three tables plus a
// multiRemove of every history-derived AsyncStorage key. A release build
// that somehow reaches seedScenario / wipeToFreshAccount (analytics
// replay, deep link, future caller, bad merge) MUST refuse with zero
// touches. These tests pin that contract.

describe('seedScenario __DEV__ guard', () => {
  const originalDev = (globalThis as { __DEV__?: boolean }).__DEV__;

  beforeEach(() => {
    supabaseDeleteSpy.mockClear();
    supabaseUpdateSpy.mockClear();
    supabaseUpsertSpy.mockClear();
    supabaseInsertSpy.mockClear();
    supabaseFromSpy.mockClear();
    asyncStorageMultiRemoveSpy.mockClear();
    asyncStorageSetItemSpy.mockClear();
    asyncStorageRemoveItemSpy.mockClear();
    (supabase.auth.getUser as jest.Mock).mockClear();
  });
  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = originalDev;
  });

  it('returns a guarded SeedResult and performs no mutations when __DEV__ is false', async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;

    const result = await seedScenario('fresh_cold_start');

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ stage: 'guard', message: 'dev only' }]);
    expect(result.summary).toMatch(/dev/i);

    // Zero touches on Supabase: no builder opened, no mutating verb called,
    // no auth read. The whole call must short-circuit on line 1.
    expect(supabaseFromSpy).not.toHaveBeenCalled();
    expect(supabaseDeleteSpy).not.toHaveBeenCalled();
    expect(supabaseUpdateSpy).not.toHaveBeenCalled();
    expect(supabaseUpsertSpy).not.toHaveBeenCalled();
    expect(supabaseInsertSpy).not.toHaveBeenCalled();
    expect(supabase.auth.getUser).not.toHaveBeenCalled();

    // Zero AsyncStorage mutations.
    expect(asyncStorageMultiRemoveSpy).not.toHaveBeenCalled();
    expect(asyncStorageSetItemSpy).not.toHaveBeenCalled();
    expect(asyncStorageRemoveItemSpy).not.toHaveBeenCalled();
  });
});

describe('wipeToFreshAccount __DEV__ guard', () => {
  const originalDev = (globalThis as { __DEV__?: boolean }).__DEV__;

  beforeEach(() => {
    supabaseDeleteSpy.mockClear();
    supabaseUpdateSpy.mockClear();
    supabaseUpsertSpy.mockClear();
    supabaseInsertSpy.mockClear();
    supabaseFromSpy.mockClear();
    asyncStorageMultiRemoveSpy.mockClear();
    asyncStorageSetItemSpy.mockClear();
    asyncStorageRemoveItemSpy.mockClear();
    (supabase.auth.getUser as jest.Mock).mockClear();
  });
  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = originalDev;
  });

  it('returns a guarded SeedResult and performs no mutations when __DEV__ is false', async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;

    const result = await wipeToFreshAccount();

    expect(result.ok).toBe(false);
    expect(result.scenarioId).toBe('wipe');
    expect(result.errors).toEqual([{ stage: 'guard', message: 'dev only' }]);

    // Same zero-touch contract as seedScenario.
    expect(supabaseFromSpy).not.toHaveBeenCalled();
    expect(supabaseDeleteSpy).not.toHaveBeenCalled();
    expect(supabaseUpdateSpy).not.toHaveBeenCalled();
    expect(supabaseUpsertSpy).not.toHaveBeenCalled();
    expect(supabaseInsertSpy).not.toHaveBeenCalled();
    expect(supabase.auth.getUser).not.toHaveBeenCalled();

    expect(asyncStorageMultiRemoveSpy).not.toHaveBeenCalled();
    expect(asyncStorageSetItemSpy).not.toHaveBeenCalled();
    expect(asyncStorageRemoveItemSpy).not.toHaveBeenCalled();
  });
});
