// Per-day pin for the dashboard coach hero.
//
// Without this, the hero could change line on every refresh: the selector
// re-ranks each focus, the AI rephrase swap-in lands a different string,
// or the underlying observations advance mid-day. That's jarring — the
// hero is supposed to be the day's spoken read, not a slot machine.
//
// Contract: once a hero line has been chosen for today, the SAME factSig
// keeps rendering on every subsequent focus that day. It changes only
// when (a) the calendar date rolls over or (b) the pinned line is no
// longer in the coach-message store (so we have nothing to render).
// Today's workout completion hides the hero entirely, so we don't need
// to invalidate the pin there — the gate above the renderer handles it.
//
// Storage shape: ONE key per user. The stored value carries both the
// date (so a stale day collapses to null on read) and the factSig. This
// avoids the AsyncStorage-key-leak that would come from a
// per-(user, date) key shape.
//
// All functions catch and reportSilent on failure; readers fall through
// to "no pin" so a storage error never blocks the hero.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportSilent } from './errorReporting';

const STORAGE_KEY_PREFIX = 'coachHero:pin:';

function keyFor(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

interface StoredPin {
  date: string;
  factSig: string;
}

/**
 * Return the pinned factSig for today, or null when none is pinned (or
 * the stored pin belongs to a different date). Never throws.
 */
export async function readPinnedHeroFactSig(
  userId: string,
  todayIso: string,
): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPin>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.date !== todayIso) return null;
    if (typeof parsed.factSig !== 'string' || parsed.factSig.length === 0) return null;
    return parsed.factSig;
  } catch (e) {
    reportSilent(e, 'coachHeroPin:read');
    return null;
  }
}

/** Pin a factSig as today's hero. Overwrites any prior pin. Never throws. */
export async function writePinnedHeroFactSig(
  userId: string,
  todayIso: string,
  factSig: string,
): Promise<void> {
  try {
    if (!userId || !todayIso || !factSig) return;
    const payload: StoredPin = { date: todayIso, factSig };
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify(payload));
  } catch (e) {
    reportSilent(e, 'coachHeroPin:write');
  }
}

/** Tri-valued plan-aware mode. Mirrors src/utils/planShift's TodayKind so
 *  callers don't have to thread two different unions. 'unknown' means the
 *  plan isn't loaded yet — the hero must suppress, NEVER assert rest. */
export type HeroTodayKind = 'training' | 'rest' | 'unknown';

/** True for a rest_day observation's factSig encoding. The BRAIN uses
 *  `rest-{YYYY-MM-DD}` for the rest_day observation. The pin guard uses
 *  this to detect "yesterday's rest_day still pinned today" / "earlier
 *  transient unknown pinned rest on a training day." */
function isRestFactSig(factSig: string | null | undefined): boolean {
  return typeof factSig === 'string' && factSig.startsWith('rest-');
}

/**
 * Pure selection: which factSig should the hero render?
 *
 *   - todayKind === 'unknown'  → null (suppress; plan not loaded yet).
 *   - A pinned rest_day on a training day (or a pinned training fact on a
 *     rest day) is INCOHERENT — discard the pin and re-pick. The caller's
 *     re-pin overwrites the stale stored value.
 *   - If `pinnedFactSig` is set AND still resolves to an existing stored
 *     message (factSig in `availableFactSigs`) AND is consistent with
 *     todayKind, keep it. This is the stability beat.
 *   - Otherwise return the first newly-picked factSig.
 *   - Returns null when there is nothing to render (no pin, no picks).
 *
 * Decoupled from React + AsyncStorage so it's unit-testable. The host
 * (home.tsx) wires reads/writes around it. `todayKind` is optional for
 * back-compat with the v1 contract; when omitted, no coherence guard.
 */
export function chooseHeroFactSig(
  pickedFactSigs: ReadonlyArray<string>,
  availableFactSigs: ReadonlySet<string>,
  pinnedFactSig: string | null,
  todayKind?: HeroTodayKind,
): string | null {
  // Plan not loaded — never render a hero (and never serve a stale pin
  // that might be a rest line on a training day).
  if (todayKind === 'unknown') return null;

  // Coherence guard. A pinned factSig that contradicts today's kind is
  // the exact bug shape we're closing: a transient unknown pass pinned
  // rest_day, plan then loaded as training, the rest line resurfaced.
  let coherentPinned = pinnedFactSig;
  if (coherentPinned && todayKind) {
    const isRestPin = isRestFactSig(coherentPinned);
    if (todayKind === 'training' && isRestPin) coherentPinned = null;
    if (todayKind === 'rest' && !isRestPin) coherentPinned = null;
  }

  if (coherentPinned && availableFactSigs.has(coherentPinned)) {
    return coherentPinned;
  }
  return pickedFactSigs[0] ?? null;
}
