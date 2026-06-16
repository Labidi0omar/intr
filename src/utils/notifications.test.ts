// Imported from notificationsPure (the pure module) so jest doesn't have
// to compile the AsyncStorage/expo-constants/react-native graph. The
// runtime entry point (notifications.ts) re-exports the same symbols.
import {
  COMEBACK_DELAY_SECONDS,
  DEFAULT_NOTIF_TIME,
  MIN_STREAK_TO_PROTECT,
  STREAK_PROTECT_HOUR,
  extractPlannedDays,
  isStreakAtRisk,
  pickDefaultNotifTime,
  secondsUntilStreakProtection,
  shouldRescheduleComeback,
} from './notificationsPure';

describe('pickDefaultNotifTime', () => {
  it('returns 18:00 as the default reminder time', () => {
    expect(pickDefaultNotifTime()).toEqual({ hour: 18, minute: 0 });
    expect(DEFAULT_NOTIF_TIME).toEqual({ hour: 18, minute: 0 });
  });
});

describe('extractPlannedDays', () => {
  const plan = [
    { day: 'Monday', workoutType: 'Push' },
    { day: 'Tuesday', workoutType: 'Rest' },
    { day: 'Wednesday', workoutType: 'Pull' },
    { day: 'Thursday', workoutType: 'Rest' },
    { day: 'Friday', workoutType: 'Legs' },
    { day: 'Saturday', workoutType: 'Rest' },
    { day: 'Sunday', workoutType: 'Rest' },
  ];

  it('returns only non-rest day names from a raw array plan', () => {
    expect(extractPlannedDays(plan)).toEqual(['Monday', 'Wednesday', 'Friday']);
  });

  it('accepts the legacy { days: [...] } wrapper shape', () => {
    expect(extractPlannedDays({ days: plan })).toEqual(['Monday', 'Wednesday', 'Friday']);
  });

  it('returns [] for null, undefined, or malformed input', () => {
    expect(extractPlannedDays(null)).toEqual([]);
    expect(extractPlannedDays(undefined)).toEqual([]);
    expect(extractPlannedDays({})).toEqual([]);
    expect(extractPlannedDays('nope')).toEqual([]);
  });

  it('skips entries missing day or workoutType', () => {
    expect(
      extractPlannedDays([
        { day: 'Monday' },
        { workoutType: 'Push' },
        { day: 'Tuesday', workoutType: 'Push' },
      ]),
    ).toEqual(['Tuesday']);
  });
});

describe('shouldRescheduleComeback', () => {
  it('reschedules when permission is granted and not in Expo Go', () => {
    expect(shouldRescheduleComeback({ permissionGranted: true, inExpoGo: false })).toBe(true);
  });

  it('does not reschedule without permission', () => {
    expect(shouldRescheduleComeback({ permissionGranted: false, inExpoGo: false })).toBe(false);
  });

  it('does not reschedule in Expo Go even if permission claims granted', () => {
    expect(shouldRescheduleComeback({ permissionGranted: true, inExpoGo: true })).toBe(false);
  });
});

describe('COMEBACK_DELAY_SECONDS', () => {
  it('is exactly 3 days in seconds', () => {
    expect(COMEBACK_DELAY_SECONDS).toBe(3 * 24 * 60 * 60);
  });
});

describe('isStreakAtRisk', () => {
  const base = { currentStreak: 3, todayIsPlannedTraining: true, todayCompleted: false };

  it('fires when a real streak has an unfinished planned session today', () => {
    expect(isStreakAtRisk(base)).toBe(true);
  });

  it('does not fire once today is completed (clears the nudge)', () => {
    expect(isStreakAtRisk({ ...base, todayCompleted: true })).toBe(false);
  });

  it('does not fire on a rest day (no planned session to protect)', () => {
    expect(isStreakAtRisk({ ...base, todayIsPlannedTraining: false })).toBe(false);
  });

  it('does not fire below the minimum streak (one day is not yet a habit)', () => {
    expect(isStreakAtRisk({ ...base, currentStreak: MIN_STREAK_TO_PROTECT - 1 })).toBe(false);
    expect(isStreakAtRisk({ ...base, currentStreak: MIN_STREAK_TO_PROTECT })).toBe(true);
  });

  it('tolerates a non-finite streak without firing', () => {
    expect(isStreakAtRisk({ ...base, currentStreak: NaN })).toBe(false);
  });
});

describe('secondsUntilStreakProtection', () => {
  it('returns the seconds remaining until the protection hour when it is ahead', () => {
    const now = new Date(2026, 5, 14, STREAK_PROTECT_HOUR - 1, 0, 0); // one hour before
    expect(secondsUntilStreakProtection(now)).toBe(60 * 60);
  });

  it('returns null when the protection hour has already passed (never schedules into the past)', () => {
    const now = new Date(2026, 5, 14, STREAK_PROTECT_HOUR, 0, 1); // one second after
    expect(secondsUntilStreakProtection(now)).toBeNull();
  });

  it('returns null exactly at the protection hour', () => {
    const now = new Date(2026, 5, 14, STREAK_PROTECT_HOUR, 0, 0);
    expect(secondsUntilStreakProtection(now)).toBeNull();
  });

  it('honors a custom hour argument', () => {
    const now = new Date(2026, 5, 14, 8, 0, 0);
    expect(secondsUntilStreakProtection(now, 9)).toBe(60 * 60);
  });
});
