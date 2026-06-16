/// <reference types="node" />
// Tests for the delete-account client wrapper.
//
// Verified by structure:
//   1. The auth-header gate (isBearerAuthorization) — mirrored exactly
//      from the edge function — rejects missing / non-Bearer / empty-token
//      values. This is the "rejects request with no/invalid auth" guarantee.
//   2. requestDeleteAccount sends NO body to supabase.functions.invoke.
//      Sending a user_id from the client is the only way a user could
//      target someone else; we assert the body is empty so it's the test
//      that prevents that drift.
//   3. performDeleteAccount on SUCCESS: signOut called, AsyncStorage.clear called.
//   4. performDeleteAccount on FAILURE: signOut NOT called, AsyncStorage.clear NOT called.
//
// We cannot run admin.deleteUser from jest — that's the edge function's
// server-side service-role call. The unit-level guarantees above are the
// shape the live integration test (manual smoke on deploy) verifies.

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  const clear = jest.fn(async () => {
    for (const k of Object.keys(store)) delete store[k];
  });
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
      setItem: jest.fn((k: string, v: string) => { store[k] = v; return Promise.resolve(); }),
      removeItem: jest.fn((k: string) => { delete store[k]; return Promise.resolve(); }),
      clear,
      __store: store,
    },
  };
});

jest.mock('./supabase', () => {
  const invoke = jest.fn();
  const signOut = jest.fn();
  return { supabase: { functions: { invoke }, auth: { signOut } } };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import {
  isBearerAuthorization,
  performDeleteAccount,
  requestDeleteAccount,
} from './deleteAccount';

const asyncStore = (AsyncStorage as any).__store as Record<string, string>;
const mockInvoke = (supabase as any).functions.invoke as jest.Mock;
const mockSignOut = (supabase as any).auth.signOut as jest.Mock;
const mockAsyncClear = (AsyncStorage as any).clear as jest.Mock;

beforeEach(() => {
  for (const k of Object.keys(asyncStore)) delete asyncStore[k];
  mockInvoke.mockReset();
  mockSignOut.mockReset();
  mockAsyncClear.mockClear();
});

// ── 1. Auth gate (mirrors the edge function) ────────────────────────────

describe('isBearerAuthorization — mirrored edge-function gate', () => {
  it('rejects a missing Authorization header', () => {
    expect(isBearerAuthorization(undefined)).toBe(false);
    expect(isBearerAuthorization(null)).toBe(false);
    expect(isBearerAuthorization('')).toBe(false);
  });

  it('rejects a header that does not start with "Bearer "', () => {
    expect(isBearerAuthorization('Basic abc')).toBe(false);
    expect(isBearerAuthorization('Token xyz')).toBe(false);
    expect(isBearerAuthorization('bearer abc')).toBe(false); // case-sensitive
    expect(isBearerAuthorization('Bearerabc')).toBe(false);  // no space
  });

  it('rejects "Bearer " with no token after the prefix', () => {
    expect(isBearerAuthorization('Bearer ')).toBe(false);
  });

  it('accepts a Bearer header with a non-empty token', () => {
    expect(isBearerAuthorization('Bearer abc.def.ghi')).toBe(true);
    expect(isBearerAuthorization('Bearer x')).toBe(true);
  });
});

// ── 2. requestDeleteAccount — empty body, only-the-caller contract ──────

describe('requestDeleteAccount', () => {
  it('invokes "delete-account" with NO body — never smuggles a user id', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await requestDeleteAccount();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [fnName, opts] = mockInvoke.mock.calls[0];
    expect(fnName).toBe('delete-account');
    // The contract: no body at all. The edge function reads the user id
    // from auth.getUser() server-side, never from the request.
    expect(opts).toBeUndefined();
  });

  it('parses a successful response', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(requestDeleteAccount()).resolves.toEqual({ ok: true });
  });

  it('returns ok:false with the message when the SDK returns an error', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: { message: 'http 401' } });
    await expect(requestDeleteAccount()).resolves.toEqual({ ok: false, error: 'http 401' });
  });

  it('returns ok:false when the response body is missing or malformed', async () => {
    for (const data of [null, undefined, {}, { ok: false }, { ok: 'true' }, 'wat' as any]) {
      mockInvoke.mockResolvedValueOnce({ data, error: null });
      const r = await requestDeleteAccount();
      expect(r.ok).toBe(false);
    }
  });

  it('returns ok:false (does NOT throw) when the SDK throws', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('network down'));
    await expect(requestDeleteAccount()).resolves.toMatchObject({ ok: false });
  });
});

// ── 3. performDeleteAccount — success vs failure ────────────────────────

describe('performDeleteAccount — on SUCCESS', () => {
  it('calls signOut AND clears AsyncStorage', async () => {
    asyncStore['plan:current'] = '{"days":[]}';
    asyncStore['coachMessages:abc'] = '[]';
    asyncStore['pendingWorkoutSave:abc:2026-06-08'] = '{}';

    mockInvoke.mockResolvedValueOnce({ data: { ok: true }, error: null });
    mockSignOut.mockResolvedValueOnce(undefined);

    await expect(performDeleteAccount()).resolves.toEqual({ ok: true });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockAsyncClear).toHaveBeenCalledTimes(1);
    // Every per-user blob is gone — no leak into the next login.
    expect(Object.keys(asyncStore)).toEqual([]);
  });
});

describe('performDeleteAccount — on FAILURE', () => {
  it('does NOT sign out and does NOT clear AsyncStorage when the API returns an error', async () => {
    asyncStore['plan:current'] = '{"days":[]}';
    mockInvoke.mockResolvedValueOnce({ data: null, error: { message: 'server boom' } });

    const r = await performDeleteAccount();
    expect(r.ok).toBe(false);

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockAsyncClear).not.toHaveBeenCalled();
    // The cached plan is still there — the user is still signed in.
    expect(asyncStore['plan:current']).toBe('{"days":[]}');
  });

  it('does NOT sign out and does NOT clear when the SDK throws', async () => {
    asyncStore['plan:current'] = '{"days":[]}';
    mockInvoke.mockRejectedValueOnce(new Error('network down'));

    const r = await performDeleteAccount();
    expect(r.ok).toBe(false);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockAsyncClear).not.toHaveBeenCalled();
    expect(asyncStore['plan:current']).toBe('{"days":[]}');
  });

  it('does NOT sign out when the body has ok:false (server-side rejection)', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { ok: false, error: 'denied' }, error: null });
    const r = await performDeleteAccount();
    expect(r.ok).toBe(false);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockAsyncClear).not.toHaveBeenCalled();
  });
});
