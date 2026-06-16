import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportSilent } from './errorReporting';

// Stage 1 of the home-screen widget: the JS data bridge.
//
// The eventual native widget (iOS WidgetKit / Android App Widget) CANNOT
// reach Supabase or any in-app state. It reads from platform-specific shared
// storage (iOS App Group via NSUserDefaults, Android SharedPreferences). The
// APP'S job is to keep that shared storage staged with the two values the
// widget displays: today's workout type and the current streak.
//
// In Stage 1 we only write to AsyncStorage under stable keys. This:
//   1. Gives the bridge a real, testable effect today (so the home.tsx hook
//      can be verified and the data shape stabilizes).
//   2. Reserves the public surface (WidgetData + WIDGET_KEYS + setWidgetData)
//      that Stage 2 will keep when it adds platform-branched writes to
//      iOS App Group / Android SharedPreferences. No callers change.
//
// Stage 2 will add the platform branches inside setWidgetData. Until then,
// the AsyncStorage write is a useful debug signal (you can inspect the
// staged values in dev) and a no-risk no-op for shipping.

/** Shape the future native widget reads. Keep stable across stages. */
export interface WidgetData {
  /**
   * Today's session label. "Push" / "Pull" / "Legs" / etc. on a workout day;
   * the literal string "Rest" on a rest day; null when there's no plan yet
   * (new account / fetch error).
   */
  todayWorkoutType: string | null;
  /** Current streak in days. 0 when unknown / new account. */
  streakCount: number;
  /** ISO timestamp; widget can use to detect stale data. */
  updatedAt: string;
}

/**
 * Storage keys are EXPORTED constants so the native widget can read the
 * exact same keys from the App Group / SharedPreferences in Stage 2.
 * Prefix `liftr.widget.*` namespaces them away from other app keys.
 */
export const WIDGET_KEYS = {
  todayWorkoutType: 'liftr.widget.todayWorkoutType',
  streakCount: 'liftr.widget.streakCount',
  updatedAt: 'liftr.widget.updatedAt',
} as const;

/**
 * Encoding note: AsyncStorage values are strings. A `null` todayWorkoutType
 * is persisted as the literal empty string `''`. The native side (Stage 2)
 * must treat `''` as "no session known" and render the empty state, NOT a
 * workout titled "".
 */
function encodeWorkoutType(v: string | null | undefined): string {
  return v == null ? '' : v;
}

/**
 * Stage today's widget data. Fire-and-forget: never throws, never blocks the
 * UI. Mirrors the analytics.ts pattern — a widget-write failure must never
 * break the dashboard render.
 *
 * Stage 2 TODO: branch on Platform.OS inside the try block:
 *   - ios: expo-widgets ExtensionStorage.set({...}) against the App Group
 *          (group.com.intr.app or similar; suffix decided in Stage 2).
 *   - android: write the same keys to SharedPreferences ('liftr_widget_prefs')
 *          via the expo-widgets module; the widget provider reads from there.
 * The AsyncStorage staging below stays as a debug signal in both stages.
 */
export async function setWidgetData(data: WidgetData): Promise<void> {
  try {
    const todayWorkoutType = encodeWorkoutType(data.todayWorkoutType);
    // Numbers and dates go in as strings; same on the native read side.
    const streakCount = String(data.streakCount ?? 0);
    const updatedAt = data.updatedAt;

    await AsyncStorage.multiSet([
      [WIDGET_KEYS.todayWorkoutType, todayWorkoutType],
      [WIDGET_KEYS.streakCount, streakCount],
      [WIDGET_KEYS.updatedAt, updatedAt],
    ]);
  } catch (e) {
    // Swallow. Fire-and-forget.
    reportSilent(e, 'widgetBridge:setWidgetData');
  }
}
