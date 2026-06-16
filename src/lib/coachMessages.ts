// Persistent coach-message store, backed by AsyncStorage.
//
// Why this exists: the post-workout recap used to render as a Modal on the
// completion screen, which made it ephemeral (vanishes the moment the user
// dismisses it) and easy to miss. The new home is a coach card on the
// dashboard that surfaces the latest message on next open. This module is
// the store behind that card.
//
// Storage shape: per-user list of CoachMessage, newest-first, capped at
// MAX_MESSAGES (8). Each entry carries an `id`, the recap `text`, an ISO
// `createdAt`, a `seen` flag (for the "new" indicator on the card), and a
// `kind` discriminant ('recap' today; future kinds slot in here).
//
// Why AsyncStorage, not Supabase: we deliberately don't promote this to a
// migration. Per-device history is fine for v1 — if we later want recap
// history to survive reinstalls or sync across devices we'll add a
// coach_messages table at that time.
//
// Error handling: every function catches and routes to Sentry via
// reportSilent. None throw. A read failure returns []; a write failure
// returns the unchanged list. The card always renders something usable.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportSilent } from './errorReporting';

const STORAGE_KEY_PREFIX = 'coachMessages:';

/** Cap. The selector pulls recent factSigs from the trailing dedupKeys —
 *  ~20 gives the memory guard enough history to suppress recently-spoken
 *  facts without bloating the JSON blob on every focus. */
export const MAX_MESSAGES = 20;

export type CoachMessageKind =
  /** Post-workout reflection (set in finishWorkout). */
  | 'recap'
  /** Pre-workout autoregulation narration (set in handleStartWorkout) —
   *  the coach saying "I'm pulling things down today" or "green light"
   *  before the session starts. See src/lib/coachHints.ts. */
  | 'autoreg'
  /** Deterministic dashboard observation (BRAIN/MOUTH pipeline). Replaces
   *  briefing/deload/pr/streak as the single canonical write path. The
   *  legacy kinds remain in VALID_KINDS so blobs written by an older build
   *  still load — they are NEVER written by the current code. */
  | 'observation'
  /** Post-workout campaign status (set in finishWorkout, right after the
   *  recap) — the "Week 3 of the hypertrophy block / bench up 7.5 kg /
   *  deload in 5 days" multi-line progress framing. Built deterministically
   *  by src/lib/campaignStatus.ts. */
  | 'campaign'
  /** @deprecated Legacy: kept only so old AsyncStorage blobs still load. */
  | 'briefing'
  /** @deprecated Legacy: kept only so old AsyncStorage blobs still load. */
  | 'deload'
  /** @deprecated Legacy: kept only so old AsyncStorage blobs still load. */
  | 'pr'
  /** @deprecated Legacy: kept only so old AsyncStorage blobs still load. */
  | 'streak';

/** Single source of truth for what `kind` strings are valid on disk. The
 *  loader filters against this so a kind that was added in code but never
 *  saved survives load (and an unknown kind from a future build is dropped
 *  rather than crashing the parse). The four legacy kinds (briefing /
 *  deload / pr / streak) remain here so already-stored messages survive
 *  the migration to 'observation'; the current code path never writes
 *  them. Update this when adding a kind above. */
const VALID_KINDS: ReadonlySet<CoachMessageKind> = new Set<CoachMessageKind>([
  'recap',
  'autoreg',
  'observation',
  'campaign',
  'briefing',
  'deload',
  'pr',
  'streak',
]);

export interface CoachMessage {
  /** Unique within the per-user list. Date-encoded so newer ids sort later. */
  id: string;
  text: string;
  /** ISO 8601 timestamp (UTC). */
  createdAt: string;
  /** True once the dashboard card has surfaced this message to the user. */
  seen: boolean;
  kind: CoachMessageKind;
  /** Optional idempotency key. Set by appendCoachMessageOnce — a second
   *  call with the same key is a no-op. Used for once-per-event messages
   *  (e.g. one readiness narration per day, even if the user backs out
   *  and re-starts the same workout). */
  dedupKey?: string;
}

function keyFor(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

/** id = ${time-in-base36}-${6-char-random}. Stable, sortable, no UUID dep. */
function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Read the user's coach messages. Returns [] on missing/corrupt storage and
 * sends the failure to Sentry — the card just shows nothing rather than
 * surfacing a parse error.
 */
export async function loadCoachMessages(userId: string): Promise<CoachMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — a future refactor that bumps the schema
    // shouldn't crash on the old blob; we just drop malformed entries.
    return parsed.filter(
      (m: any) =>
        m &&
        typeof m.id === 'string' &&
        typeof m.text === 'string' &&
        typeof m.createdAt === 'string' &&
        typeof m.seen === 'boolean' &&
        VALID_KINDS.has(m.kind)
    ) as CoachMessage[];
  } catch (e) {
    reportSilent(e, 'coachMessages:load');
    return [];
  }
}

export interface AppendCoachMessageInput {
  text: string;
  kind?: CoachMessageKind;
  /** Optional injection for tests; defaults to now(). */
  createdAt?: string;
  /** Optional injection for tests; defaults to a generated id. */
  id?: string;
  /** Optional idempotency tag stored on the message. Most callers should
   *  use appendCoachMessageOnce instead — it sets this and enforces
   *  no-op-on-duplicate semantics. */
  dedupKey?: string;
}

/**
 * Prepend a new coach message. Newest-first ordering, length-capped at
 * MAX_MESSAGES. A dedup guard prevents two finishes within the same second
 * from double-storing the same text — finishWorkout is also gated by the
 * coachRecap:{userId}:{date} day-cache, but this is belt-and-suspenders.
 *
 * Returns the new full list (or the unchanged list on storage error) so
 * callers that already have a UI mounted can update without re-reading.
 */
export async function appendCoachMessage(
  userId: string,
  input: AppendCoachMessageInput,
): Promise<CoachMessage[]> {
  try {
    if (!input.text || !input.text.trim()) return await loadCoachMessages(userId);
    const existing = await loadCoachMessages(userId);
    const msg: CoachMessage = {
      id: input.id ?? makeId(),
      text: input.text.trim(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      seen: false,
      kind: input.kind ?? 'recap',
      ...(input.dedupKey ? { dedupKey: input.dedupKey } : {}),
    };
    // Dedup: head matches → no-op. Same finish flow firing twice in one
    // second shouldn't bloat the list.
    if (
      existing[0] &&
      existing[0].text === msg.text &&
      existing[0].createdAt === msg.createdAt
    ) {
      return existing;
    }
    const next = [msg, ...existing].slice(0, MAX_MESSAGES);
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify(next));
    return next;
  } catch (e) {
    reportSilent(e, 'coachMessages:append');
    return [];
  }
}

/**
 * Idempotent append. If any existing message already carries the same
 * `dedupKey`, the call is a no-op — the existing list is returned
 * unchanged. Otherwise the message is prepended (newest-first, capped at
 * MAX_MESSAGES) with the dedupKey persisted on the stored entry so the
 * next call hits the same guard.
 *
 * Used for once-per-event messages where the calling surface might fire
 * multiple times — e.g. the pre-workout readiness narration runs on every
 * Start tap, but should only enter the coach card once per day.
 *
 * Typical key shape: `${kind}:${yyyy-mm-dd}` — collision-free across days
 * and across kinds.
 */
export async function appendCoachMessageOnce(
  userId: string,
  dedupKey: string,
  input: AppendCoachMessageInput,
): Promise<CoachMessage[]> {
  try {
    if (!dedupKey) return await appendCoachMessage(userId, input);
    const existing = await loadCoachMessages(userId);
    // Already stored under this key — leave the list intact. The dedup
    // guard is independent of `seen`, so a re-Start after the user has
    // already viewed the card doesn't re-mark it unseen either.
    if (existing.some(m => m.dedupKey === dedupKey)) return existing;
    return await appendCoachMessage(userId, { ...input, dedupKey });
  } catch (e) {
    reportSilent(e, 'coachMessages:appendOnce');
    return [];
  }
}

/**
 * Mark every stored message as seen. Called by the dashboard card once it
 * has surfaced the latest message; clears the "new" indicator for the next
 * focus. No-op when nothing changed (avoids a write per focus).
 */
export async function markCoachMessagesSeen(userId: string): Promise<void> {
  try {
    const existing = await loadCoachMessages(userId);
    if (existing.length === 0) return;
    if (existing.every(m => m.seen)) return;
    const next = existing.map(m => ({ ...m, seen: true }));
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify(next));
  } catch (e) {
    reportSilent(e, 'coachMessages:markSeen');
  }
}

/**
 * Return the most recent unseen message, or null when every message has
 * been viewed (or there are none). Pure — operates on a passed-in list so
 * the dashboard can derive state from the same load() it already did.
 */
export function latestUnseen(msgs: readonly CoachMessage[]): CoachMessage | null {
  for (const m of msgs) if (!m.seen) return m;
  return null;
}

/**
 * Locate the stored message whose dedupKey ends with `:${factSig}` (the
 * observation dedup-key shape) and rewrite its text. No-op when no match
 * is found, when the new text is empty, or when the new text equals the
 * existing text. Used by the AI rephrasing layer to upgrade a deterministic
 * line in place after the network call resolves — the next dashboard
 * focus picks up the new copy.
 *
 * Preserves `seen`, `createdAt`, `id`, `kind`, and `dedupKey` exactly —
 * only `text` changes. This matters: the dashboard's "new" dot is keyed
 * off `seen`, and we explicitly do NOT want to re-mark a message unseen
 * just because the AI got back to us 800ms after the user viewed it.
 */
export async function updateCoachMessageTextByFactSig(
  userId: string,
  factSig: string,
  newText: string,
): Promise<void> {
  try {
    const trimmed = (newText ?? '').trim();
    if (!trimmed || !factSig) return;
    const existing = await loadCoachMessages(userId);
    if (existing.length === 0) return;
    const suffix = `:${factSig}`;
    let changed = false;
    const next = existing.map(m => {
      if (m.dedupKey && m.dedupKey.endsWith(suffix) && m.text !== trimmed) {
        changed = true;
        return { ...m, text: trimmed };
      }
      return m;
    });
    if (!changed) return;
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify(next));
  } catch (e) {
    reportSilent(e, 'coachMessages:updateByFactSig');
  }
}
