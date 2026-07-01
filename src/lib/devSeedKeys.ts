// AsyncStorage wipe inventory for the dev seeder. Split out of devSeed.ts
// so the unit tests can pin the list without pulling in supabase, RN, or
// any side-effecting helper. Importing this file is dependency-free; the
// constants and the picker are pure functions over arrays of strings.

/** History-derived keys to remove by exact match. */
export const HISTORY_EXACT_KEYS: readonly string[] = [
  // Active weekly plan blob — derived from weekly_plans rows.
  'plan:current',
  // Cached profile-shaping inputs — derived from profiles row.
  'user:profileInputs',
];

/** History-derived keys to remove by prefix match. The trailing colon
 *  (where present) is intentional so a sibling key that happens to share
 *  a leading substring isn't swept. Each entry is documented with the
 *  call site that writes it. */
export const HISTORY_PREFIX_KEYS: readonly string[] = [
  // Per-user dashboard messages (src/lib/coachMessages.ts).
  'coachMessages:',
  // Per-user dashboard hero pin (src/lib/coachHeroPin.ts).
  'coachHero:pin:',
  // Versioned per-factSig AI-rephrase cache (src/lib/coachVoiceAI.ts).
  'coachVoiceAI:',
  // Per-user gap-modal resolution watermark (src/utils/planShift.ts).
  'gap:resolvedThrough:',
  // Per-user / per-date pending finish-workout saves (src/lib/pendingSync.ts).
  'pendingWorkoutSave:',
  // Per-date in-progress workout cache (app/workout.tsx).
  'intr_workout_',
  // Per-user / per-date workout recap cache (app/workout.tsx).
  'coachRecap:',
  // Per-user / per-gap / per-day gap acknowledgement flag (home.tsx).
  'intr:gapAck:',
  // Per-user "plan ready" analytics fire-once flag (home.tsx).
  'intr:plan_ready_fired:',
  // Per-user recovery-unlock flag (home.tsx).
  'recovery:unlocked:',
];

/** Device-preference keys that must NOT appear in either wipe list. The
 *  unit test cross-checks. Adding a new preserve key here is the right way
 *  to opt a key OUT of wiping. */
export const PRESERVE_KEYS: readonly string[] = [
  // User's gym/home default (app/(tabs)/profile.tsx).
  'user:defaultLocation',
  // Notification preference (src/utils/notifications.ts).
  'intr_notification_time',
  'intr_notif_permission_asked',
  // Journal-migration completion flag (app/(tabs)/journal.tsx).
  'intr:journal:migratedToSupabase',
];

/** Filter `allKeys` to the subset this seeder owns wiping. Pure + tested. */
export function pickHistoryKeysToWipe(allKeys: readonly string[]): string[] {
  const exact = new Set(HISTORY_EXACT_KEYS);
  return allKeys.filter(
    k => exact.has(k) || HISTORY_PREFIX_KEYS.some(p => k.startsWith(p)),
  );
}
