// Tiny wrapper around Sentry.captureException for our "silent catch" pattern.
//
// Why this exists: a lot of code in this app catches errors on purpose —
// a Supabase read that failed shouldn't crash the screen, an AsyncStorage
// cache write that failed shouldn't block the user, a notification
// permission denial shouldn't blow up onboarding. The existing pattern was
//
//   try { …network… } catch { /* tolerated */ }
//
// which is right for the user but wrong for us: real bugs (RLS misconfig,
// missing column, JSON parse on a corrupt blob) become invisible in prod.
// Every silent catch should still tell Sentry it happened.
//
// Usage:
//   try { … } catch (e) { reportSilent(e, 'home:fetchProfile'); }
//
// The `tag` becomes a searchable breadcrumb in Sentry so we can group the
// catches by call site without inspecting the stack. Keep it short and
// stable — `file:method` works well.
//
// DSN setup: src/lib/errorReporting only forwards to Sentry; the SDK is
// initialised in app/_layout.tsx using EXPO_PUBLIC_SENTRY_DSN. When the
// DSN env var is unset (local dev without the dashboard wired), Sentry
// no-ops and these calls are free. See CLAUDE.md for the full setup.

import * as Sentry from '@sentry/react-native';

/**
 * Report an error that was caught and intentionally swallowed by the caller.
 * Never throws — safe to call inside any catch block.
 *
 * @param error  The caught error. Wrapped into a real Error if it isn't one
 *               (Sentry handles strings/objects but stack-grouping is worse).
 * @param tag    Stable identifier for this call site, e.g. 'home:fetchProfile'
 *               or 'workout:loadHistory'. Surfaces in Sentry as a tag.
 * @param extra  Optional context bag attached to the event. Use sparingly —
 *               avoid PII; user id is already attached at the SDK level.
 */
export function reportSilent(
  error: unknown,
  tag: string,
  extra?: Record<string, unknown>,
): void {
  try {
    const err =
      error instanceof Error
        ? error
        : new Error(`[${tag}] ${safeStringify(error)}`);
    Sentry.captureException(err, scope => {
      scope.setTag('silent_catch', tag);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          // Sentry's setExtra accepts any JSON-serializable value; be defensive
          // about cyclic structures by stringifying first.
          scope.setExtra(k, typeof v === 'string' ? v : safeStringify(v));
        }
      }
      return scope;
    });
  } catch {
    // captureException itself failing must not blow up the caller — Sentry
    // is a best-effort surface, not a hard dependency. There is nowhere
    // useful to forward this to; eat it.
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
