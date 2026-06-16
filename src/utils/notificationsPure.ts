// Pure helpers for the notifications layer. Lives in its own file (no
// react-native / expo-constants / AsyncStorage imports) so jest can load
// it under the node test environment. notifications.ts re-exports these
// alongside the native scheduling functions.

export type NotifTime = { hour: number; minute: number };

export const DEFAULT_NOTIF_TIME: NotifTime = { hour: 18, minute: 0 };
export const COMEBACK_DELAY_SECONDS = 3 * 24 * 60 * 60;

/** Default reminder time used when we auto-enable after onboarding. */
export function pickDefaultNotifTime(): NotifTime {
  return DEFAULT_NOTIF_TIME;
}

/** Extract the day names of planned (non-rest) workouts from a plan blob.
 *  Accepts either the raw days array or { days: [...] } legacy shape. */
export function extractPlannedDays(plan: unknown): string[] {
  const days = Array.isArray(plan)
    ? plan
    : Array.isArray((plan as { days?: unknown })?.days)
      ? (plan as { days: unknown[] }).days
      : [];
  const out: string[] = [];
  for (const d of days) {
    const day = d as { day?: string; workoutType?: string };
    if (day && day.workoutType && day.workoutType !== 'Rest' && day.day) {
      out.push(day.day);
    }
  }
  return out;
}

/** Decide whether we should (re)schedule the comeback nudge. We always
 *  reschedule on app open / workout finish so the nudge stays ~3 days
 *  out from the user's last interaction. */
export function shouldRescheduleComeback(args: {
  permissionGranted: boolean;
  inExpoGo: boolean;
}): boolean {
  return args.permissionGranted && !args.inExpoGo;
}

// ── Streak-protection nudge ───────────────────────────────────────────────
// One warm, non-shaming reminder when the user has a streak worth keeping and
// today's planned session isn't done yet. Tone matches the rest-day streak
// color call: encouraging, never punitive. Exactly one nudge — the native
// scheduler cancels any prior streak reminder before scheduling a fresh one.

/** A streak must be at least this long before we bother protecting it — one
 *  completed day isn't yet a habit to defend, and nudging there would read as
 *  nagging rather than encouraging. */
export const MIN_STREAK_TO_PROTECT = 2;

/** Local hour-of-day the protection nudge fires — evening, late enough to be a
 *  gentle "still time today" rather than a morning alarm. */
export const STREAK_PROTECT_HOUR = 19;

/**
 * The at-risk condition: a real streak is going AND today is a planned
 * training day the user hasn't completed. Pure; the caller supplies the
 * streak (from calculateStreak) and today's plan/completion state.
 */
export function isStreakAtRisk(args: {
  currentStreak: number;
  todayIsPlannedTraining: boolean;
  todayCompleted: boolean;
}): boolean {
  return (
    Number.isFinite(args.currentStreak) &&
    args.currentStreak >= MIN_STREAK_TO_PROTECT &&
    args.todayIsPlannedTraining &&
    !args.todayCompleted
  );
}

/**
 * Seconds from `now` until today's protection hour. null when that hour has
 * already passed — we never schedule into the past, so a late open just means
 * no nudge today (honest, and avoids a fire-immediately surprise).
 */
export function secondsUntilStreakProtection(now: Date, hour = STREAK_PROTECT_HOUR): number | null {
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  const secs = Math.round((target.getTime() - now.getTime()) / 1000);
  return secs > 0 ? secs : null;
}
