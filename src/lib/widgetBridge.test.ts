// AsyncStorage isn't available in the node-jest environment used by this
// project (no react-native transform). Inline-mock it with a tiny in-memory
// store so we can assert what setWidgetData actually writes.
//
// jest.mock factory runs at module-init time, BEFORE the SUT import, so
// the SUT's `import AsyncStorage from '@react-native-async-storage/async-storage'`
// resolves to this mock rather than the real native bridge module.

import { setWidgetData, WIDGET_KEYS } from './widgetBridge';

let store: Record<string, string> = {};
let multiSetImpl: (kv: [string, string][]) => Promise<void> = async (kv) => {
  for (const [k, v] of kv) store[k] = v;
};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    multiSet: (kv: [string, string][]) => multiSetImpl(kv),
  },
}));

beforeEach(() => {
  store = {};
  multiSetImpl = async (kv) => {
    for (const [k, v] of kv) store[k] = v;
  };
});

describe('setWidgetData', () => {
  it('writes all three widget keys to AsyncStorage', async () => {
    await setWidgetData({
      todayWorkoutType: 'Push',
      streakCount: 7,
      updatedAt: '2026-06-01T10:00:00.000Z',
    });
    expect(store[WIDGET_KEYS.todayWorkoutType]).toBe('Push');
    expect(store[WIDGET_KEYS.streakCount]).toBe('7');
    expect(store[WIDGET_KEYS.updatedAt]).toBe('2026-06-01T10:00:00.000Z');
  });

  it('encodes null todayWorkoutType as empty string (no throw)', async () => {
    await setWidgetData({
      todayWorkoutType: null,
      streakCount: 0,
      updatedAt: '2026-06-01T10:00:00.000Z',
    });
    expect(store[WIDGET_KEYS.todayWorkoutType]).toBe('');
    expect(store[WIDGET_KEYS.streakCount]).toBe('0');
  });

  it("writes 'Rest' verbatim on rest days", async () => {
    await setWidgetData({
      todayWorkoutType: 'Rest',
      streakCount: 3,
      updatedAt: '2026-06-01T10:00:00.000Z',
    });
    expect(store[WIDGET_KEYS.todayWorkoutType]).toBe('Rest');
  });

  it('swallows an AsyncStorage error — resolves, does not reject', async () => {
    multiSetImpl = async () => {
      throw new Error('disk full');
    };
    // Should NOT reject.
    await expect(
      setWidgetData({
        todayWorkoutType: 'Push',
        streakCount: 1,
        updatedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
    // Store was never touched (mock threw before write).
    expect(store).toEqual({});
  });

  it('coerces a missing streakCount to "0" when input is unexpectedly nullish', async () => {
    // Defensive: TypeScript guarantees streakCount: number on the public
    // surface, but if callers pass undefined past the type check (e.g. via
    // a Supabase response cast), we should still emit "0" rather than
    // "undefined" or "null".
    await setWidgetData({
      todayWorkoutType: 'Pull',
      // @ts-expect-error — testing defensive runtime coercion
      streakCount: undefined,
      updatedAt: '2026-06-01T10:00:00.000Z',
    });
    expect(store[WIDGET_KEYS.streakCount]).toBe('0');
  });
});
