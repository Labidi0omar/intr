// Client wrapper for the delete-account edge function.
//
// Contract:
//   - requestDeleteAccount calls the edge function with NO body. Sending a
//     user_id from the client would defeat the security model — the edge
//     function reads the caller's id from auth.getUser() only. The empty
//     body is part of the contract; the test below asserts it.
//   - performDeleteAccount runs the full client flow: invoke → on success,
//     sign out + AsyncStorage.clear() so a stale plan / coach message /
//     pending save from the deleted user can't leak into the next login.
//     On failure: do NOTHING client-side (no sign-out, no clear) — the
//     account is still alive on the server and the user must stay logged
//     in to retry.
//   - isBearerAuthorization is mirrored from supabase/functions/delete-
//     account/index.ts. The two implementations are kept in sync by THIS
//     test — if the edge function ever loosens its auth gate, the test
//     here would still need an explicit code change to follow, surfacing
//     the drift in code review.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { reportSilent } from './errorReporting';

export type DeleteAccountResult = { ok: true } | { ok: false; error: string };

/**
 * Pure mirror of the edge function's `Authorization` header gate. Exported
 * so the contract is unit-testable from jest (Deno code can't be run from
 * the jest harness).
 *
 * Accepts the value of the `Authorization` request header. Returns true
 * only when it starts with `'Bearer '` AND contains a non-empty token
 * after the prefix.
 */
export function isBearerAuthorization(header: string | null | undefined): boolean {
  if (!header) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return header.length > prefix.length;
}

/**
 * Call the delete-account edge function. Sends NO body — the user id is
 * derived server-side from auth.getUser(). Returns the discriminated union
 * the caller switches on. Never throws.
 */
export async function requestDeleteAccount(): Promise<DeleteAccountResult> {
  try {
    // Deliberately omit `body`. Sending one would still be ignored by the
    // edge function, but omitting it makes the contract obvious at the
    // call site and lets the test assert on it.
    const { data, error } = await supabase.functions.invoke('delete-account');
    if (error) {
      const msg = typeof (error as any)?.message === 'string'
        ? (error as any).message
        : 'Account deletion failed';
      return { ok: false, error: msg };
    }
    if (!data || typeof data !== 'object' || (data as { ok?: unknown }).ok !== true) {
      return { ok: false, error: 'Account deletion failed' };
    }
    return { ok: true };
  } catch (e) {
    // Network failure, SDK throw — surface as a generic error so the UI
    // can show "try again", without leaking implementation noise.
    reportSilent(e, 'deleteAccount:requestThrow');
    return { ok: false, error: 'Network error — try again' };
  }
}

/**
 * Full delete flow. ONLY on a confirmed server-side delete (ok=true) do
 * we sign out + clear local storage. On any failure path the user stays
 * signed in so they can retry.
 *
 * Returns the same result shape so the UI can route on success and show
 * an error otherwise. The caller handles navigation (router.replace).
 */
export async function performDeleteAccount(): Promise<DeleteAccountResult> {
  const result = await requestDeleteAccount();
  if (!result.ok) return result;

  // Server confirmed delete. Now sign out and nuke local caches so the
  // next login on this device can't pick up:
  //   - cached weekly plans (plan:current, …)
  //   - pendingWorkoutSave queues for the deleted user
  //   - coach messages
  //   - any other per-user blob in AsyncStorage
  try {
    await supabase.auth.signOut();
  } catch (e) {
    reportSilent(e, 'deleteAccount:signOut');
  }
  try {
    await AsyncStorage.clear();
  } catch (e) {
    reportSilent(e, 'deleteAccount:asyncStorageClear');
  }
  return { ok: true };
}
