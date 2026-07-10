// Semantic wrapper over expo-haptics. Every haptic in the app flows
// through here so intent stays consistent across screens and swapping
// the underlying backend (or muting haptics globally) is a one-file
// change.
//
// All functions no-op unless we're on iOS or Android. Every call
// swallows its own error — a haptic that fails to trigger must never
// break the surrounding flow, and it's not worth a Sentry event.
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

async function safe(fn: () => Promise<unknown> | unknown): Promise<void> {
  if (!enabled) return;
  try {
    await fn();
  } catch {
    // Haptics are advisory. Never surface — no throw, no reportSilent.
  }
}

/** Light impact — subtle "you touched something" tap. */
export function tap(): Promise<void> {
  return safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** Selection change — steppers, +/- buttons, discrete-value pickers. */
export function select(): Promise<void> {
  return safe(() => Haptics.selectionAsync());
}

/** Medium impact — set completion, meaningful action landed. */
export function impact(): Promise<void> {
  return safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** Notification-style success — rest timer done, workout finished. */
export function success(): Promise<void> {
  return safe(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
}

/** Notification-style warning — non-fatal caveat (e.g. form validation). */
export function warn(): Promise<void> {
  return safe(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  );
}

/** PR celebration — heavy impact, then a success chime ~90ms later. */
export async function pr(): Promise<void> {
  await safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
  await new Promise<void>(r => setTimeout(r, 90));
  await safe(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
}
