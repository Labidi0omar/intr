import { supabase } from '../lib/supabase';
import { isRecoverySession, type RecoverySessionLike } from '../lib/recovery';

/**
 * Pure helper: current consecutive-day streak ending today (or yesterday if
 * today has no completed session), from a set of YYYY-MM-DD strings.
 *
 * Extracted so the "recovery counts toward streak" contract is testable
 * without mocking Supabase — the caller controls which dates are in the
 * set. The contract: pass EVERY completed date (recovery or normal); the
 * helper doesn't differentiate.
 */
export function currentStreakFromDateSet(
  completedDates: ReadonlySet<string>,
  today: Date,
): number {
  if (completedDates.size === 0) return 0;
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = iso(today);
  let startIdx = completedDates.has(todayStr) ? 0 : 1;
  let streak = 0;
  for (let i = startIdx; ; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    if (completedDates.has(iso(d))) streak++;
    else break;
  }
  return streak;
}

/**
 * Build the date set the streak should count, given a list of completed
 * workout_sessions rows. Per the asymmetric product rule, recovery sessions
 * ARE included — the only filter is `completed=true`, applied at the query.
 *
 * This wrapper exists so the inclusion is explicit and testable: if a future
 * change accidentally drops recovery rows here, the test in
 * src/lib/recovery.test.ts fails immediately.
 */
export function completedDateSetFromSessions(
  rows: readonly (RecoverySessionLike & { planned_date: string })[],
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r || !r.planned_date) continue;
    // Recovery is intentionally KEPT — see audit in src/lib/recovery.ts.
    // isRecoverySession is only referenced here to make the inclusion
    // explicit at the read site; we don't actually filter on it.
    void isRecoverySession;
    out.add(r.planned_date);
  }
  return out;
}

/** Helper to get Monday of a given week. Maps JS Day properly. */
const getMonday = (d: Date | string) => {
  const date = new Date(d);
  const day = date.getDay();
  // JS getDay(): 0 is Sunday. We want Monday to be start of week.
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
};

export const calculateStreak = async (userId: string) => {
  try {
    // INCLUSION BOUNDARY: streak DOES count recovery sessions. The product
    // rule is asymmetric — recovery is invisible to load progression / PR
    // detection / RIR / mesocycle, but the streak/habit counts any
    // completed session. Do NOT add .eq('is_recovery', false) here.
    // See src/lib/recovery.ts for the full read-site audit.
    const { data: sessions } = await supabase
      .from('workout_sessions')
      .select('planned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .order('planned_date', { ascending: false });

    if (!sessions || sessions.length === 0) return { current: 0, longest: 0 };

    const uniqueDates = new Set(sessions.map(s => s.planned_date));
    
    let currentStreak = 0;
    const now = new Date();
    
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let startIdx = uniqueDates.has(todayStr) ? 0 : 1;

    for (let i = startIdx; ; i++) {
       const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
       const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
       if (uniqueDates.has(dateStr)) {
         currentStreak++;
       } else {
         break;
       }
    }

    let longestStreak = currentStreak;
    let tempStreak = 1;
    const sortedDates = Array.from(uniqueDates).sort((a, b) => b.localeCompare(a));
    
    for (let j = 0; j < sortedDates.length - 1; j++) {
      const d1 = new Date(sortedDates[j]);
      const d2 = new Date(sortedDates[j+1]);
      const diffDays = Math.round((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        tempStreak++;
        if (tempStreak > longestStreak) longestStreak = tempStreak;
      } else {
        tempStreak = 1;
      }
    }

    return { current: currentStreak, longest: longestStreak };
  } catch (e) {
    console.error('calculateStreak error:', e);
    return { current: 0, longest: 0 };
  }
};

export const calculateMonthlyConsistency = async (userId: string) => {
  try {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const { data: profile } = await supabase
      .from('profiles')
      .select('training_days')
      .eq('id', userId)
      .single();
      
    const defaultPlannedPerWeek = profile?.training_days || 3;

    const { data: sessions } = await supabase
      .from('workout_sessions')
      .select('completed_at')
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('completed_at', startOfThisMonth.toISOString())
      .lte('completed_at', endOfThisMonth.toISOString());

    const completedCount = sessions ? sessions.length : 0;
    
    // Estimate planned count for the month roughly scaling weekly goal
    const daysInMonth = endOfThisMonth.getDate();
    const weeksInMonth = daysInMonth / 7;
    const plannedCount = Math.round(weeksInMonth * defaultPlannedPerWeek);

    const percentage = plannedCount > 0 ? Math.round((completedCount / plannedCount) * 100) : 0;

    return { completedCount, plannedCount, percentage: Math.min(percentage, 100) };
  } catch (e) {
    console.error('calculateMonthlyConsistency error:', e);
    return { completedCount: 0, plannedCount: 0, percentage: 0 };
  }
};

const getLocalIsoString = (y: number, m: number, d: number) => {
  const date = new Date(y, m - 1, d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

type DayState = 'completed' | 'missed' | 'planned' | 'rest';

interface DayResult {
  date: string;
  dayName: string;
  isToday: boolean;
  state: DayState;
}

export const getNextSevenDays = async (userId: string): Promise<DayResult[]> => {
  try {
    const now = new Date();
    const todayStr = getLocalIsoString(now.getFullYear(), now.getMonth() + 1, now.getDate());

    const dateStrings: string[] = [];
    const baseDays: { date: string; fullDayName: string; isToday: boolean }[] = [];

    // Home: Next 7 days starting from today (today is index 0)
    for (let i = 0; i < 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const dayStr = getLocalIsoString(d.getFullYear(), d.getMonth() + 1, d.getDate());
        
        const dayNamesMap = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const fullDayName = dayNamesMap[d.getDay()];
        
        baseDays.push({ 
          date: dayStr, 
          fullDayName,
          isToday: dayStr === todayStr
        });
        dateStrings.push(dayStr);
    }

    const startDateStr = dateStrings[0];
    const endDateStr = dateStrings[dateStrings.length - 1];

    const { data: sessions, error: sessionsErr } = await supabase
      .from('workout_sessions')
      .select('planned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('planned_date', startDateStr)
      .lte('planned_date', endDateStr);

    if (sessionsErr) console.error('Sessions fetch error for dot tracking:', sessionsErr);

    const completedDates = (sessions || []).map(s => s.planned_date);

    // The plan horizon now holds up to 4 future rows (today, +7, +14, +21),
    // so a flat limit(2) sorted desc would lock onto rows past the strip
    // window and miss the row that actually covers each strip day. Filter to
    // rows whose week_start could cover any date in the strip window
    // ([startDateStr - 6, endDateStr]) — that's the only span we need.
    const { data: plans } = await supabase
      .from('weekly_plans')
      .select('week_start, plan')
      .eq('user_id', userId)
      .gte('week_start', getLocalIsoString(
        Number(startDateStr.slice(0, 4)),
        Number(startDateStr.slice(5, 7)),
        Number(startDateStr.slice(8, 10)) - 6,
      ))
      .lte('week_start', endDateStr)
      .order('week_start', { ascending: false });

    const plannedDatesMap: Record<string, boolean> = {};
    for (const d of baseDays) {
      const dateParts = d.date.split('-').map(Number);
      const dateMinus7Str = getLocalIsoString(dateParts[0], dateParts[1], dateParts[2] - 7);
      const planRow = (plans || []).find(p => p.week_start <= d.date && p.week_start > dateMinus7Str);
      let isPlanned = false;
      if (planRow && planRow.plan) {
         let planDays: string[] = [];
         if (Array.isArray(planRow.plan.days)) {
             planDays = planRow.plan.days.map((x: any) => x.day);
         } else if (Array.isArray(planRow.plan)) {
             planDays = planRow.plan.map((x: any) => x.day);
         }
         isPlanned = planDays.includes(d.fullDayName);
      }
      plannedDatesMap[d.date] = isPlanned;
    }

    return baseDays.map(dayObj => {
       const isCompleted = completedDates.includes(dayObj.date);
       const isPlanned = plannedDatesMap[dayObj.date];
       
       let state: DayState = 'rest';
       
       if (isCompleted) {
         state = 'completed';
       } else if (isPlanned) {
         state = 'planned'; // Home: never missed.
       }
       
       return {
         date: dayObj.date,
         dayName: dayObj.fullDayName,
         isToday: dayObj.isToday,
         state
       };
    });
  } catch (e) {
    console.error('getNextSevenDays error:', e);
    const now = new Date();
    const todayStr = getLocalIsoString(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const fallback: DayResult[] = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const dayStr = getLocalIsoString(d.getFullYear(), d.getMonth() + 1, d.getDate());
        const dayNamesMap = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        fallback.push({ 
          date: dayStr, 
          dayName: dayNamesMap[d.getDay()], 
          isToday: dayStr === todayStr, 
          state: 'rest' 
        });
    }
    return fallback;
  }
};

export const getLastSevenDays = async (userId: string): Promise<DayResult[]> => {
  try {
    const now = new Date();
    const todayStr = getLocalIsoString(now.getFullYear(), now.getMonth() + 1, now.getDate());
    
    const dateStrings: string[] = [];
    const baseDays: { date: string; fullDayName: string; isToday: boolean }[] = [];
    
    // History: Past 7 days ending today (today is index 6)
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const dayStr = getLocalIsoString(d.getFullYear(), d.getMonth() + 1, d.getDate());
        const dayNamesMap = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const fullDayName = dayNamesMap[d.getDay()];
        
        baseDays.push({ 
          date: dayStr, 
          fullDayName,
          isToday: dayStr === todayStr
        });
        dateStrings.push(dayStr);
    }

    const startDateStr = dateStrings[0];
    const endDateStr = dateStrings[dateStrings.length - 1];

    const { data: sessions, error: sessionsErr } = await supabase
      .from('workout_sessions')
      .select('planned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('planned_date', startDateStr)
      .lte('planned_date', endDateStr);

    if (sessionsErr) console.error('Sessions fetch error for dot tracking:', sessionsErr);
    
    const completedDates = (sessions || []).map(s => s.planned_date);

    // The plan horizon now holds up to 4 future rows (today, +7, +14, +21),
    // so a flat limit(2) sorted desc would lock onto rows past the strip
    // window and miss the row that actually covers each strip day. Filter to
    // rows whose week_start could cover any date in the strip window
    // ([startDateStr - 6, endDateStr]) — that's the only span we need.
    const { data: plans } = await supabase
      .from('weekly_plans')
      .select('week_start, plan')
      .eq('user_id', userId)
      .gte('week_start', getLocalIsoString(
        Number(startDateStr.slice(0, 4)),
        Number(startDateStr.slice(5, 7)),
        Number(startDateStr.slice(8, 10)) - 6,
      ))
      .lte('week_start', endDateStr)
      .order('week_start', { ascending: false });

    const plannedDatesMap: Record<string, boolean> = {};
    for (const d of baseDays) {
      const dateParts = d.date.split('-').map(Number);
      const dateMinus7Str = getLocalIsoString(dateParts[0], dateParts[1], dateParts[2] - 7);
      const planRow = (plans || []).find(p => p.week_start <= d.date && p.week_start > dateMinus7Str);
      let isPlanned = false;
      if (planRow && planRow.plan) {
         let planDays: string[] = [];
         if (Array.isArray(planRow.plan.days)) {
             planDays = planRow.plan.days.map((x: any) => x.day);
         } else if (Array.isArray(planRow.plan)) {
             planDays = planRow.plan.map((x: any) => x.day);
         }
         isPlanned = planDays.includes(d.fullDayName);
      }
      plannedDatesMap[d.date] = isPlanned;
    }

    return baseDays.map(dayObj => {
       const isCompleted = completedDates.includes(dayObj.date);
       const isPlanned = plannedDatesMap[dayObj.date];
       
       let state: DayState = 'rest';
       
       if (isCompleted) {
         state = 'completed';
       } else if (isPlanned) {
         if (dayObj.date < todayStr) {
           state = 'missed';
         } else {
           state = 'planned';
         }
       }
       
       return {
         date: dayObj.date,
         dayName: dayObj.fullDayName,
         isToday: dayObj.isToday,
         state
       };
    });
  } catch (e) {
    console.error('getLastSevenDays error mapping dynamic boundaries:', e);
    const fallback: DayResult[] = [];
    const now = new Date();
    const todayStr = getLocalIsoString(now.getFullYear(), now.getMonth() + 1, now.getDate());
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const dayStr = getLocalIsoString(d.getFullYear(), d.getMonth() + 1, d.getDate());
        const dayNamesMap = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        fallback.push({ 
          date: dayStr, 
          dayName: dayNamesMap[d.getDay()], 
          isToday: dayStr === todayStr, 
          state: 'rest' 
        });
    }
    return fallback;
  }
};

export const shouldSuggestProgression = async (userId: string) => {
  try {
     const streak = await calculateStreak(userId);
     return streak.current >= 4;
  } catch(e) {
     return false;
  }
};
