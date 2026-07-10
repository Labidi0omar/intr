import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { reportSilent } from '../lib/errorReporting';

import {
  COMEBACK_DELAY_SECONDS,
  extractPlannedDays,
  isStreakAtRisk,
  pickDefaultNotifTime,
  secondsUntilStreakProtection,
  type NotifTime,
} from './notificationsPure';

export const NOTIF_TIME_KEY = 'intr_notification_time';
export const NOTIF_PERMISSION_ASKED_KEY = 'intr_notif_permission_asked';
export const COMEBACK_DATA_TAG = 'comeback';
/** Data tag on the streak-protection nudge. Kept distinct from 'workout' and
 *  'comeback' so each kind can be cancelled/preserved independently. */
export const STREAK_DATA_TAG = 'streak';
export const ANDROID_CHANNEL_ID = 'workout-reminders';

export {
  COMEBACK_DELAY_SECONDS,
  DEFAULT_NOTIF_TIME,
  MIN_STREAK_TO_PROTECT,
  STREAK_PROTECT_HOUR,
  extractPlannedDays,
  isStreakAtRisk,
  pickDefaultNotifTime,
  secondsUntilStreakProtection,
  shouldRescheduleComeback,
  type NotifTime,
} from './notificationsPure';

// ── Native scheduling ─────────────────────────────────────────────────

function inExpoGo(): boolean {
  return Constants.appOwnership === 'expo';
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const Notifications = await import('expo-notifications');
    // No `sound` key here — a HIGH-importance channel plays the device's
    // default notification sound automatically. Passing the literal string
    // 'default' is a bad-resource id and throws at channel-create time on
    // some Android builds. Per-notification `sound: true` in the content
    // payload still asks the OS to use the default sound at fire-time.
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: 'Workout reminders',
      importance: Notifications.AndroidImportance.HIGH,
    });
  } catch (e) {
    reportSilent(e, 'notifications:ensureChannel');
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (inExpoGo()) {
    console.warn('Notifications disabled in Expo Go SDK 53+');
    return false;
  }
  try {
    const Notifications = await import('expo-notifications');
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted') return true;
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  } catch (e) {
    reportSilent(e, 'notifications:requestPermission');
    return false;
  }
}

export async function getSavedNotifTime(): Promise<NotifTime | null> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_TIME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    reportSilent(e, 'notifications:getSavedTime');
    return null;
  }
}

export async function saveNotifTime(time: NotifTime): Promise<void> {
  await AsyncStorage.setItem(NOTIF_TIME_KEY, JSON.stringify(time));
}

export async function scheduleWorkoutNotifications(
  plannedDays: string[],
  _weekStart: string,
  time: NotifTime
): Promise<void> {
  if (inExpoGo()) return;
  try {
    const Notifications = await import('expo-notifications');
    await ensureAndroidChannel();

    // Cancel only the previous weekly workout reminders. We keep the
    // comeback AND streak-protection notifications (different data tags)
    // intact so a plan re-sync doesn't reset the comeback countdown or wipe
    // a pending streak nudge.
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const n of scheduled) {
      const tag = n.content.data?.type;
      if (tag !== COMEBACK_DATA_TAG && tag !== STREAK_DATA_TAG) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier);
      }
    }

    const dayNameToIndex: Record<string, number> = {
      Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
      Thursday: 4, Friday: 5, Saturday: 6,
    };

    const messages = [
      "Time to train.",
      "Your workout is queued.",
      "Show up. That's all.",
      "The session is waiting.",
      "Lift today.",
    ];

    for (const dayName of plannedDays) {
      const weekday = dayNameToIndex[dayName];
      if (weekday === undefined) continue;
      const message = messages[Math.floor(Math.random() * messages.length)];

      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Intr',
          body: message,
          sound: true,
          data: { type: 'workout' },
          ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday: weekday + 1,
          hour: time.hour,
          minute: time.minute,
          ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
        },
      });
    }
  } catch (e) {
    reportSilent(e, 'notifications:scheduleWorkout');
  }
}

export async function cancelAllNotifications(): Promise<void> {
  if (inExpoGo()) return;
  try {
    const Notifications = await import('expo-notifications');
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (e) {
    reportSilent(e, 'notifications:cancelAll');
  }
}

export async function scheduleTestNotification(): Promise<void> {
  if (inExpoGo()) return;
  try {
    const Notifications = await import('expo-notifications');
    await ensureAndroidChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Intr Test',
        body: 'Notifications are working.',
        sound: true,
        ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 5,
        repeats: false,
        ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
    });
  } catch (e) {
    reportSilent(e, 'notifications:scheduleTest');
  }
}

/** Reschedule the "haven't seen you in a few days" nudge. Cancels any
 *  pending comeback first, then schedules a fresh one COMEBACK_DELAY_SECONDS
 *  in the future. Call this on app foreground and on workout finish so it
 *  only ever fires if the user has actually been absent ~3 days. */
export async function scheduleComebackNotification(): Promise<void> {
  if (inExpoGo()) return;
  try {
    const Notifications = await import('expo-notifications');
    await ensureAndroidChannel();

    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const n of scheduled) {
      if (n.content.data?.type === COMEBACK_DATA_TAG) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier);
      }
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Intr',
        body: "Been a few days. The plan's still here when you are.",
        sound: true,
        data: { type: COMEBACK_DATA_TAG },
        ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: COMEBACK_DELAY_SECONDS,
        repeats: false,
        ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
    });
  } catch (e) {
    reportSilent(e, 'notifications:scheduleComeback');
  }
}

/** (Re)schedule the single streak-protection nudge for today. Always cancels
 *  any prior streak nudge first — one reminder, never stacking. Schedules a
 *  fresh one ONLY when the streak is genuinely at risk (an active streak +
 *  today is an unfinished planned training day) and the protection hour is
 *  still ahead today. Respects the user's notification setting: no-op unless
 *  permission is granted AND a reminder time is saved (same gate as the weekly
 *  reminders), so it never re-prompts or fires for users who opted out.
 *
 *  Fire-and-forget — call on dashboard focus / workout finish. Never throws. */
export async function syncStreakProtectionNotification(args: {
  currentStreak: number;
  todayIsPlannedTraining: boolean;
  todayCompleted: boolean;
}): Promise<void> {
  if (inExpoGo()) return;
  try {
    const Notifications = await import('expo-notifications');

    // Respect the notification setting: granted permission AND an enabled
    // reminder time. If the user never enabled reminders, we stay silent.
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') return;
    const time = await getSavedNotifTime();
    if (!time) return;

    await ensureAndroidChannel();

    // One nudge, never nagging: clear any pending streak reminder first. If
    // the streak is no longer at risk (e.g. the user just finished today),
    // this leaves them with none — exactly what we want.
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const n of scheduled) {
      if (n.content.data?.type === STREAK_DATA_TAG) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier);
      }
    }

    if (!isStreakAtRisk(args)) return;

    const seconds = secondsUntilStreakProtection(new Date());
    if (seconds == null) return; // protection hour already passed today.

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Intr',
        // Warm + encouraging, mirroring the rest-day streak color call —
        // momentum, not guilt.
        body: `Your ${args.currentStreak}-day streak is still going. A few minutes today keeps it alive.`,
        sound: true,
        data: { type: STREAK_DATA_TAG },
        ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds,
        repeats: false,
        ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
    });
  } catch (e) {
    reportSilent(e, 'notifications:streakProtection');
  }
}

/** Read the live plan + saved time and (re)schedule the weekly reminders.
 *  No-op if no time saved or permission missing. Called from planSync after
 *  any plan write and from the app foreground hook. */
export async function syncWorkoutNotifications(): Promise<void> {
  if (inExpoGo()) return;
  try {
    const time = await getSavedNotifTime();
    if (!time) return;

    const Notifications = await import('expo-notifications');
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== 'granted') return;

    const raw = await AsyncStorage.getItem('plan:current');
    if (!raw) return;
    const plan = JSON.parse(raw);
    const plannedDays = extractPlannedDays(plan?.days ?? plan);
    if (plannedDays.length === 0) return;

    await scheduleWorkoutNotifications(plannedDays, plan?.weekStart ?? '', time);
  } catch (e) {
    reportSilent(e, 'notifications:sync');
  }
}

/** Called once after onboarding (or first plan gen). Prompts for permission
 *  the first time only, saves a default reminder time if granted, and
 *  schedules against the current plan. Subsequent calls no-op via the
 *  asked-flag. The user can still change/disable the time in Profile. */
export async function enableNotificationsIfFirstTime(): Promise<void> {
  if (inExpoGo()) return;
  try {
    const asked = await AsyncStorage.getItem(NOTIF_PERMISSION_ASKED_KEY);
    if (asked) return;
    await AsyncStorage.setItem(NOTIF_PERMISSION_ASKED_KEY, '1');

    const granted = await requestNotificationPermission();
    if (!granted) return;

    const existing = await getSavedNotifTime();
    const time = existing ?? pickDefaultNotifTime();
    if (!existing) await saveNotifTime(time);

    await syncWorkoutNotifications();
  } catch (e) {
    reportSilent(e, 'notifications:enableFirstTime');
  }
}
