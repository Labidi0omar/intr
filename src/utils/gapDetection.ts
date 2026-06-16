import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';

/**
 * Detect how many days it's been since the user last completed a workout.
 * Returns 0 if the last completed session was 0-2 days ago (today, yesterday,
 * day before, or never). Returns gap count (3+) otherwise.
 *
 * Semantics shifted from "days since last check-in" to "days since last
 * completed workout" when the dead daily_checkins table was removed. Rest
 * days do not reset the gap.
 */
export async function detectReturnGap(userId: string): Promise<number> {
  const { data } = await supabase
    .from('workout_sessions')
    .select('planned_date')
    .eq('user_id', userId)
    .eq('completed', true)
    .order('planned_date', { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return 0;

  const lastDate = new Date(data[0].planned_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  lastDate.setHours(0, 0, 0, 0);

  const diffMs = today.getTime() - lastDate.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  // 0, 1, or 2 days gap → no gap worth reporting for plan reset
  if (diffDays <= 2) return 0;

  return diffDays;
}

/**
 * Shift the plan stored in plan:current forward by gapDays.
 * Adjusts weekStart date and each day's date by the gap.
 * Does nothing if no plan exists.
 */
export async function shiftPlanByGap(gapDays: number): Promise<void> {
  const raw = await AsyncStorage.getItem('plan:current');
  if (!raw) return;

  const plan = JSON.parse(raw);
  if (!plan || !plan.days || !Array.isArray(plan.days) || plan.days.length === 0) return;

  // Shift weekStart forward by gapDays
  if (plan.weekStart) {
    const d = new Date(plan.weekStart + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + gapDays);
    plan.weekStart = d.toISOString().split('T')[0];
  }

  // Shift each day's date forward by gapDays
  plan.days = plan.days.map((day: any) => {
    if (day.date) {
      const d = new Date(day.date + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + gapDays);
      day.date = d.toISOString().split('T')[0];
    }
    return day;
  });

  await AsyncStorage.setItem('plan:current', JSON.stringify(plan));
}

// The within-week reslot helpers (shiftMissedForward, findMissedPlanDays)
// were removed when the resume flow switched to regenerating a catch-up
// pack from generatePlan (see src/utils/planCatchUp.ts). The unfinished-
// day scans live in ./planShift; importers should pull from there
// directly.