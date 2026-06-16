import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  LayoutAnimation,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  UIManager,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Button from '../../src/components/Button';
import WeekStrip from '../../src/components/WeekStrip';
import { get30DayPlan, type ForwardDay } from '../../src/utils/monthCalendar';
import { useTheme } from '../../src/context/ThemeContext';
import { supabase } from '../../src/lib/supabase';
import { layout, typography } from '../../src/theme';
import { detectReturnGap } from '../../src/utils/gapDetection';
import {
  countUnfinishedPastTrainingDays,
  findEarliestUnfinishedTrainingDay,
  gapResolvedThroughKey,
  resolvePlanDayForDate,
  shouldShowGapModalToday,
} from '../../src/utils/planShift';
import { buildCatchUpRows } from '../../src/utils/planCatchUp';
import { computeCompletedTrainingDays } from '../../src/utils/weekProgress';
import { ensureCurrentWeekPlan } from '../../src/lib/planSync';
import { flushPendingSaves } from '../../src/lib/pendingSync';
import { reportSilent } from '../../src/lib/errorReporting';
import {
  appendCoachMessageOnce,
  latestUnseen,
  loadCoachMessages,
  updateCoachMessageTextByFactSig,
  type CoachMessage,
} from '../../src/lib/coachMessages';
import { useTabScroll } from '../../src/context/TabScrollContext';

// Pager index of the Coach sub-tab. Hardcoded to avoid a circular import
// from TabLayout (which already imports this screen). Kept in sync with
// WORKOUT_SUB_TABS in src/components/TabLayout.tsx.
const COACH_SUB_TAB_INDEX = 3;
import { runCoachVoiceUpgrade } from '../../src/lib/coachVoiceAI';
import {
  computeGapDays,
  deriveObservations,
  isCompositeObservation,
  selectTopObservations,
  type LiftSessionTop,
  type Observation,
} from '../../src/lib/coachObservations';
import { phraseObservation, dedupKeyFor, factSigFromDedupKey } from '../../src/lib/coachVoice';
import { computeEffortZoneFromLogs, parseWeightKg } from '../../src/utils/dashboardStats';
import { track } from '../../src/lib/analytics';
import { CURRENT_PLAN_VERSION, type SplitId } from '../../src/lib/planGeneration';
import {
  CALIBRATION_SESSIONS_NEEDED,
  computeCalibration,
  computeTrainingStatus,
  decideDeloadOffer,
  deloadProximityNote,
  type TrainingStatusResult,
  type DeloadOffer,
} from '../../src/lib/trainingStatus';
import { computeEarlyWins, type EarlyWin } from '../../src/lib/earlyWins';
import { syncStreakProtectionNotification } from '../../src/utils/notifications';
import {
  applyDeloadToRows,
  clearDeloadFromRows,
  extractPlanDays as extractDeloadPlanDays,
  type PlanRowLike as DeloadPlanRowLike,
} from '../../src/lib/planDeload';
import { setWidgetData } from '../../src/lib/widgetBridge';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import {
  calculateStreak,
  calculateMonthlyConsistency,
  getNextSevenDays
} from '../../src/utils/streak';
import {
  computeEffortZone,
  computeStrengthTrend,
  type StrengthTrend,
} from '../../src/utils/dashboardStats';

// --- Types ---
type Profile = {
  username: string;
  preferred_split: string;
  training_days: number;
  fitness_level: string;
  goal?: string;
};

type WeeklyPlan = {
  id: string;
  days_planned: number;
  days_completed: number;
  today_type: 'workout' | 'rest' | 'none';
  today_workout_name?: string;
  today_duration?: number;
  /** Next upcoming planned workout (today-or-future, not completed). */
  next_workout_date?: string;        // YYYY-MM-DD
  next_workout_label?: string;       // "Today" | "Tomorrow" | "Sat" | "Mon, Jun 9"
  next_workout_name?: string;        // e.g. "Push"
};

type WorkoutSession = {
  id: string;
  type?: string;
  workout_type: string;
  date?: string;
  planned_date: string;
  completed_at?: string;
};

// --- Skeleton Component ---
const Skeleton = ({ width, height, style, borderRadius = 8, colors }: any) => {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true })
      ])
    ).start();
  }, [opacity]);

  return (
    <Animated.View style={[{ width, height, backgroundColor: colors.textMuted + '30', borderRadius, opacity }, style]} />
  );
};

// --- Recovery state dot with a gentle breathing glow ---
// A static core dot in the band color, ringed by a soft halo that slowly
// expands and fades — a calm "alive" pulse, not an alarm. Driven by
// Animated/native driver so it's cheap on the JS thread.
const PulseDot = ({ color }: { color: string }) => {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1400, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] });
  const glowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.1] });

  return (
    <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: color,
          opacity: glowOpacity,
          transform: [{ scale }],
        }}
      />
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
    </View>
  );
};

export default function HomeScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plan, setPlan] = useState<WeeklyPlan | null>(null);
  const [recentSessions, setRecentSessions] = useState<WorkoutSession[]>([]);

  // Analytics Stats
  const [streak, setStreak] = useState({ current: 0, longest: 0 });
  const [strengthTrend, setStrengthTrend] = useState<StrengthTrend>({ deltaKg: null, exercisesCompared: 0 });
  // Workouts completed this month (Momentum card → right side). Async/network
  // — fetched in fetchDashboardData, never inline in render.
  const [monthlyConsistency, setMonthlyConsistency] = useState<{ completedCount: number; plannedCount: number; percentage: number }>({ completedCount: 0, plannedCount: 0, percentage: 0 });
  // Trend-based Training Status (src/lib/trainingStatus.ts). null until the
  // first focus computes it; 'unknown' state for new users. Drives the
  // Training Status card AND the tap-to-accept deload offer below.
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatusResult | null>(null);
  // Which deload action (if any) to surface on the card. Always tap-to-accept;
  // never auto-applied. `deloadInDays` powers the "deload lands in N days"
  // explain copy. `deloadActionLoading` disables the buttons mid-write.
  const [deloadOffer, setDeloadOffer] = useState<DeloadOffer>(null);
  const [deloadInDays, setDeloadInDays] = useState<number | null>(null);
  const [deloadActionLoading, setDeloadActionLoading] = useState(false);
  // Early small-win (src/lib/earlyWins.ts) — count of lifts the user added
  // weight on recently. Surfaced as a dashboard reassurance during the
  // calibration window; {liftsImproved:0, show:false} on a fresh account so
  // nothing renders (never a misleading "0").
  const [earlyWin, setEarlyWin] = useState<EarlyWin>({ liftsImproved: 0, show: false });
  const [lastSevenDays, setLastSevenDays] = useState<any[]>([]);
  const [isRollingMode, setIsRollingMode] = useState<boolean>(true);
  const [isTodayDone, setIsTodayDone] = useState<boolean>(false);
  const [latestWeight, setLatestWeight] = useState<number | null>(null);
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [weeklyInsight, setWeeklyInsight] = useState<string | null>(null);
  // Persistent coach-message card. Loaded on focus from coachMessages store
  // (AsyncStorage). The latest entry is what finishWorkout appended on the
  // previous workout. Empty array → the card renders nothing.
  const [coachMessages, setCoachMessages] = useState<CoachMessage[]>([]);
  const { goToSubTab } = useTabScroll();
  const [returnGap, setReturnGap] = useState(0);
  const [showGapModal, setShowGapModal] = useState(false);
  // Forward 30-day plan — expanded view of the WeekStrip. Pure read; no
  // past, no navigation. Today is the first row.
  const [showMonthModal, setShowMonthModal] = useState(false);
  const [forwardDays, setForwardDays] = useState<ForwardDay[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);
  const [selectedForwardDay, setSelectedForwardDay] = useState<ForwardDay | null>(null);

  const loadForward = async () => {
    try {
      setForwardLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setForwardDays([]); return; }
      const list = await get30DayPlan(user.id);
      setForwardDays(list);
    } catch (e) {
      reportSilent(e, 'home:fetchForwardDays');
      setForwardDays([]);
    } finally {
      setForwardLoading(false);
    }
  };

  const openMonthModal = () => {
    setSelectedForwardDay(null);
    setShowMonthModal(true);
    void loadForward();
  };
  const [gapActionLoading, setGapActionLoading] = useState(false);
  const [planDays, setPlanDays] = useState<any[]>([]);
  const [completedDayNames, setCompletedDayNames] = useState<Set<string>>(new Set());
  const [weekExpanded, setWeekExpanded] = useState(false);

  const toggleWeek = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setWeekExpanded(e => !e);
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  useFocusEffect(
    useCallback(() => {
      fetchDashboardData();
    }, [])
  );

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Widget bridge: track today's workout-type label so we can stage it
      // for the home-screen widget at the end of this load. Updated in the
      // valid-plan branch below; stays null on no-plan / stale-plan paths.
      let widgetTodayType: string | null = null;

      // Streak-protection inputs, set in the valid-plan branch below and read
      // by the fire-and-forget nudge sync at the end of this load. Defaults
      // (no training planned / not done) mean "no nudge" on the no-plan path.
      let streakTodayIsTraining = false;

      // Ensure a plan exists for the current week. If onboarding is done
      // but the week rolled over (or the user opened on a fresh device),
      // this generates from profile defaults transparently.
      await ensureCurrentWeekPlan();

      // Replay any finish-workout saves that failed last session. Non-blocking
      // — flushPendingSaves swallows its own errors and reports persistent
      // failures to Sentry. We don't surface a UI here; the user already saw
      // the "saved locally" note on the complete screen.
      flushPendingSaves().catch(() => { /* tolerated; module reports to Sentry */ });

      // Load coach messages for the dashboard card. Reads only — never
      // makes a new network call (the AI fetch happens in finishWorkout).
      // The "new" dot is cleared only by opening the Coach sub-tab now,
      // so we don't call markCoachMessagesSeen from the dashboard.
      try {
        const msgs = await loadCoachMessages(user.id);
        setCoachMessages(msgs);
      } catch (e) {
        reportSilent(e, 'home:loadCoachMessages');
      }

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      // 45-day window powers the coach-observation pipeline below. Single
      // round-trip via the Promise.all so we're not paying for an extra
      // sequential roundtrip — both queries are bounded, recovery-excluded,
      // and small (a heavy lifter logs ~300 sets/45d).
      const todayDate = new Date();
      const days45Ago = new Date(todayDate);
      days45Ago.setDate(days45Ago.getDate() - 45);
      const obsFromIso = `${days45Ago.getFullYear()}-${String(days45Ago.getMonth() + 1).padStart(2, '0')}-${String(days45Ago.getDate()).padStart(2, '0')}`;

      const [
        sessionsRes,
        streakResult,
        effortZoneResult,
        strengthTrendResult,
        sevenDaysResult,
        weightRes,
        obsLogsRes,
        obsSessionsRes,
        monthlyResult,
        lifetimeCompletedRes
      ] = await Promise.all([
        supabase.from('workout_sessions').select('*').eq('user_id', user.id).order('completed_at', { ascending: false }).limit(5),
        calculateStreak(user.id),
        computeEffortZone(user.id),
        computeStrengthTrend(user.id),
        getNextSevenDays(user.id),
        supabase.from('progress_logs').select('weight_kg').eq('user_id', user.id).order('logged_date', { ascending: false }).order('created_at', { ascending: false }).limit(1),
        supabase
          .from('exercise_logs')
          .select('exercise_name, weight_kg, logged_date, reps_in_reserve, session_id, is_recovery')
          .eq('user_id', user.id)
          .eq('is_recovery', false)
          .gte('logged_date', obsFromIso)
          .order('logged_date', { ascending: true }),
        supabase
          .from('workout_sessions')
          .select('planned_date, energy_level, energy_score')
          .eq('user_id', user.id)
          .eq('completed', true)
          .gte('planned_date', obsFromIso)
          .order('planned_date', { ascending: false }),
        calculateMonthlyConsistency(user.id),
        // Lifetime completed-session count (monotonic) for the sticky
        // calibration unlock — a cheap head count, no rows returned.
        supabase
          .from('workout_sessions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('completed', true)
          .eq('is_recovery', false),
      ]);

      if (profileData) {
        setProfile(profileData as Profile);
      }

      if (!weightRes.error && weightRes.data && weightRes.data.length > 0) {
        setLatestWeight(weightRes.data[0].weight_kg);
      } else {
        setLatestWeight(null);
      }

      if (!sessionsRes.error && sessionsRes.data) {
        setRecentSessions(sessionsRes.data);
      }

      setStreak(streakResult);
      setStrengthTrend(strengthTrendResult);
      setMonthlyConsistency(monthlyResult);
      setLastSevenDays(sevenDaysResult);

      // History timeline — built from workout_sessions only (the dead
      // daily_checkins table was removed). Energy is mapped from the lossy
      // text energy_level on the session row: low→2, normal→3, high→4.
      // Missing energy → 3. Rest-day energy is not captured anywhere today.
      try {
        const { data: sessions } = await supabase
          .from('workout_sessions')
          .select('workout_type, planned_date, completed, exercises_done, energy_level')
          .eq('user_id', user.id)
          .eq('completed', true)
          .order('planned_date', { ascending: false })
          .limit(14);

        const energyFromLevel = (lvl: string | null | undefined): number =>
          lvl === 'low' ? 2 : lvl === 'high' ? 4 : 3;

        const rows = (sessions || []).map((s: any) => ({
          date: s.planned_date,
          energy_score: energyFromLevel(s.energy_level),
          reflection_snippet: null,
          muscle_group: s.workout_type || '—',
          exercise_count: s.exercises_done?.length || 0,
          has_pr: false,
        }));
        setHistoryRows(rows);

        // Weekly insight from session energy.
        if (rows.length >= 3) {
          const lowDays = rows.filter(r => r.energy_score <= 2);
          const completedSessions = rows.length;
          const window = Math.min(rows.length, 7);
          const completionRate = Math.round((completedSessions / window) * 100);
          if (lowDays.length >= 2) {
            setWeeklyInsight(`On your low days you still completed ${completionRate}% of your session. That's the number that matters.`);
          } else {
            setWeeklyInsight(`You've been consistent. ${completedSessions} sessions in the last ${window} days. Keep the rhythm.`);
          }
        }
      } catch (e) {
        // History fetch fails silently
        reportSilent(e, 'home:fetchHistory');
      }

      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      const { data: todaySession } = await supabase
        .from('workout_sessions')
        .select('id')
        .eq('user_id', user.id)
        .eq('planned_date', todayStr)
        .eq('completed', true)
        .limit(1);

      const todayDoneLocal = !!(todaySession && todaySession.length > 0);
      setIsTodayDone(todayDoneLocal);

      // We now keep up to HORIZON_WEEKS future rows (today, +7, +14, +21).
      // Filter to rows whose week_start has already started — otherwise an
      // .order().limit(1) here would return the row 3 weeks out and the
      // dashboard would render the future instead of today.
      const { data: plansData } = await supabase
        .from('weekly_plans')
        .select('*')
        .eq('user_id', user.id)
        .lte('week_start', todayStr)
        .order('week_start', { ascending: false })
        .limit(1);

      const currentPlan = plansData && plansData.length > 0 ? plansData[0] : null;

      if (currentPlan) {
        let planDaysArray: any[] = [];
        if (Array.isArray(currentPlan.plan?.days)) {
          planDaysArray = currentPlan.plan.days;
        } else if (Array.isArray(currentPlan.plan)) {
          planDaysArray = currentPlan.plan;
        }
        setPlanDays(planDaysArray);

        let targetDaysY = planDaysArray.length;

        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const wsParts = currentPlan.week_start.split('-').map(Number);
        const wsPlus6Date = new Date(wsParts[0], wsParts[1] - 1, wsParts[2] + 6);
        const wsPlus6Str = `${wsPlus6Date.getFullYear()}-${String(wsPlus6Date.getMonth() + 1).padStart(2, '0')}-${String(wsPlus6Date.getDate()).padStart(2, '0')}`;

        if (todayStr > wsPlus6Str || todayStr < currentPlan.week_start) {
          setPlan(null);
          setCompletedDayNames(new Set());
          setTrainingStatus(null);
          setDeloadOffer(null);
          setDeloadInDays(null);
          setEarlyWin({ liftsImproved: 0, show: false });
        } else {
          const { data: weekSessions } = await supabase
            .from('workout_sessions')
            .select('planned_date, is_recovery, workout_type')
            .eq('user_id', user.id)
            .gte('planned_date', currentPlan.week_start)
            .lte('planned_date', wsPlus6Str)
            .eq('completed', true)
            // EXCLUSION BOUNDARY (week progress): rest-day mobility/cardio
            // flows must not bump the "X of Y" count or the week-strip dots.
            .eq('is_recovery', false);

          // Bug fix: a day counts ONLY when it's a planned training day in
          // this week's plan AND a non-recovery session exists for it. See
          // src/utils/weekProgress.ts for the rule and the unit tests.
          // Date-anchored matching: pass week_start so a mid-week onboarder's
          // "Monday" entry (whose .date is next Monday) doesn't get cross-
          // pollinated by a session on this Monday. Same resolution rule the
          // calendar uses, so the dashboard and calendar agree by construction.
          const completedNames = computeCompletedTrainingDays(
            (weekSessions ?? []) as any,
            planDaysArray,
            currentPlan.week_start,
          );
          const targetDaysX = completedNames.size;
          // dayNamesMap retained for the "next upcoming" date math below.
          const dayNamesMap = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          setCompletedDayNames(completedNames);

          // (Legacy MissedModal detection deleted: the GapModal's
          // catch-up flow handles every stranded past training day,
          // including within-this-week misses. See the gap-detection
          // block further down in fetchDashboardData and the
          // ackGap('resume') handler.)

          // Date-based today resolver. The legacy weekday-name match
          // (planDaysArray.find(d => d.day === todayFullDayName)) drifted out
          // of sync with the calendar for mid-week onboarders whose "Monday"
          // entry was actually next Monday. resolvePlanDayForDate prefers
          // each PlanDay's explicit .date and falls back to weekStart +
          // WEEKDAY_OFFSET — the same rule the calendar and the
          // missed/shift helpers use, so all three surfaces agree.
          const todayPlan = resolvePlanDayForDate(
            planDaysArray,
            currentPlan.week_start,
            todayStr,
          );

          // Next upcoming planned workout (today-or-future, not completed).
          // Reads each PlanDay's .date if present (post date-anchor fix),
          // otherwise falls back to currentPlan.week_start + weekday offset
          // — the same legacy path used by findMissedPlanDays.
          const WEEKDAY_OFFSET_LOCAL: Record<string, number> = {
            Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3,
            Friday: 4, Saturday: 5, Sunday: 6,
          };
          const resolveDate = (d: any): string | undefined => {
            if (d?.date) return d.date as string;
            const off = WEEKDAY_OFFSET_LOCAL[d?.day];
            if (off === undefined) return undefined;
            const p = currentPlan.week_start.split('-').map(Number);
            const dd = new Date(p[0], p[1] - 1, p[2] + off);
            return `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
          };
          const upcoming: Array<{ d: any; date: string }> = planDaysArray
            .map((d: any) => ({ d, date: resolveDate(d) }))
            .filter((x: any): x is { d: any; date: string } =>
              !!x.date && x.date >= todayStr && !completedNames.has(x.d.day),
            )
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
          const next = upcoming[0];

          // Relative label: "Today", "Tomorrow", weekday name (within 7 days),
          // or "Mon, Jun 9" beyond that.
          const relativeLabel = (iso: string): string => {
            const p = iso.split('-').map(Number);
            const target = new Date(p[0], p[1] - 1, p[2]);
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const delta = Math.round((target.getTime() - today.getTime()) / 86400000);
            if (delta <= 0) return 'Today';
            if (delta === 1) return 'Tomorrow';
            if (delta < 7) return dayNamesMap[target.getDay()].slice(0, 3);
            return target.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          };

          // Funnel: fire plan_ready the FIRST time we observe a usable
          // weekly plan (≥ 1 training day) for this user. Dedup via an
          // AsyncStorage flag so repeated dashboard focuses don't
          // double-count. The user reached the "I have a real plan"
          // milestone — this is the step between onboarding_completed
          // and workout_started in the funnel view.
          if (targetDaysY > 0) {
            void (async () => {
              try {
                const flagKey = `intr:plan_ready_fired:${user.id}`;
                const already = await AsyncStorage.getItem(flagKey);
                if (already) return;
                await AsyncStorage.setItem(flagKey, '1');
                track('plan_ready', { training_days: targetDaysY });
              } catch (e) {
                reportSilent(e, 'home:planReadyFlag');
              }
            })();
          }

          setPlan({
            id: currentPlan.id,
            days_planned: targetDaysY,
            days_completed: targetDaysX,
            today_type: todayPlan ? 'workout' : 'rest',
            today_workout_name: todayPlan ? todayPlan.workoutType : undefined,
            today_duration: todayPlan ? 45 : undefined,
            next_workout_date: next?.date,
            next_workout_label: next ? relativeLabel(next.date) : undefined,
            next_workout_name: next?.d?.workoutType,
          });

          // ── Coach memory / continuity engine ───────────────────────────
          // BRAIN (deriveObservations) reads structured facts only; MOUTH
          // (phraseObservation) maps them to copy; the dedup guard is
          // per-fact (factSig) so a spoken line never repeats until the
          // underlying number advances. Both halves are pure + unit-tested
          // — this wire-up is the only stateful step.
          try {
            // ── Block week from plan:current cache (old blobs → null). ──
            let cachedBlockWeek: number | null = null;
            try {
              const rawCache = await AsyncStorage.getItem('plan:current');
              if (rawCache) {
                const cache = JSON.parse(rawCache);
                const bw = cache?.blockWeek;
                if (typeof bw === 'number' && bw >= 1 && bw <= 4) {
                  cachedBlockWeek = bw;
                }
              }
            } catch (e) {
              reportSilent(e, 'home:readBlockWeek');
            }
            const isDeload = todayPlan?.deload === true;
            const blockWeek = isDeload ? 4 : cachedBlockWeek;

            // ── Build per-lift session-top history from the 45d log fetch. ──
            // Group by exercise_name → group by session_id → max numeric kg
            // → sort by date ASC. Bodyweight rows return null from parseWeightKg
            // and are dropped (no fake "0 kg" PRs).
            const liftSessions: Record<string, LiftSessionTop[]> = {};
            const rawLogs = (obsLogsRes && !(obsLogsRes as any).error ? (obsLogsRes as any).data : []) ?? [];
            // Nested map (lift -> sessionId -> { topKg, date }) so exercise
            // names with spaces ("Bench Press") do not need a fragile
            // string-delimiter trick.
            const perLiftSession = new Map<string, Map<string, { topKg: number; date: string }>>();
            for (const row of rawLogs as Array<{ exercise_name: string; weight_kg: any; logged_date: string; session_id: string | null }>) {
              if (!row?.exercise_name || !row?.logged_date) continue;
              const w = parseWeightKg(row.weight_kg);
              if (w == null) continue;
              const sid = row.session_id ?? `_d:${row.logged_date}`;
              let bySession = perLiftSession.get(row.exercise_name);
              if (!bySession) { bySession = new Map(); perLiftSession.set(row.exercise_name, bySession); }
              const prev = bySession.get(sid);
              if (!prev || w > prev.topKg) bySession.set(sid, { topKg: w, date: row.logged_date });
            }
            for (const [lift, bySession] of perLiftSession.entries()) {
              liftSessions[lift] = Array.from(bySession.values());
            }
            for (const lift of Object.keys(liftSessions)) {
              liftSessions[lift].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
            }

            // Early small-win — reuse the just-built session-top history (no
            // extra query) to count lifts the user added weight on recently.
            // Surfaced on the dashboard during the calibration window as an
            // aggregate reassurance; the coach's lift_progression line names a
            // specific lift, so the two complement rather than duplicate.
            setEarlyWin(computeEarlyWins(liftSessions, { todayIso: todayStr }));

            // ── trainedDays14 / trainedDays28 from completed sessions. ──
            const completedDates = (
              obsSessionsRes && !(obsSessionsRes as any).error
                ? ((obsSessionsRes as any).data ?? [])
                : []
            ) as Array<{ planned_date: string }>;

            const iso14 = (() => {
              const d = new Date(todayDate); d.setDate(d.getDate() - 13);
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            const iso28 = (() => {
              const d = new Date(todayDate); d.setDate(d.getDate() - 27);
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            const distinct14 = new Set<string>();
            const distinct28 = new Set<string>();
            for (const s of completedDates) {
              if (!s.planned_date) continue;
              if (s.planned_date >= iso14) distinct14.add(s.planned_date);
              if (s.planned_date >= iso28) distinct28.add(s.planned_date);
            }
            const trainedDays14 = distinct14.size;
            const trainedDays28 = distinct28.size;

            // ── Comeback gap (pure helper — see coachObservations.ts) ──
            // The naive `expected14 − trainedDays14` math read a phantom
            // gap for any user without 14 days of history (i.e. nearly all
            // accounts at this stage). computeGapDays gates on:
            //   • baseline established (≥3 completed AND ≥14d old)
            //   • actual recent absence (≥4d since last session)
            // and prorates expected by min(14, firstSessionDaysAgo). All
            // four guard branches are unit-tested in coachObservations.test.ts.
            //
            // completedDates is sorted DESC by planned_date (set by the
            // Promise.all query above) so [0] is the most recent and
            // [length-1] is the oldest within the 45d window. A user with
            // earlier history than 45d would have firstSessionDaysAgo
            // capped at 45 — the min(14, …) prorate cap makes that a
            // no-op for the math.
            const trainingDays = Math.max(0, Math.min(7, Math.floor(profileData?.training_days ?? 0)));
            const oldestPlanned = completedDates.length > 0
              ? completedDates[completedDates.length - 1].planned_date
              : null;
            const newestPlanned = completedDates.length > 0
              ? completedDates[0].planned_date
              : null;
            const dateDiffDays = (a: string, b: string): number => {
              const pa = a.split('-').map(Number);
              const pb = b.split('-').map(Number);
              const da = new Date(pa[0], pa[1] - 1, pa[2]);
              const db = new Date(pb[0], pb[1] - 1, pb[2]);
              return Math.max(0, Math.round((db.getTime() - da.getTime()) / 86400000));
            };
            // Honest null when there's no completed history yet — both
            // computeGapDays (collapses null → 0, baseline guard fails →
            // returns 0) and the cold-start observation builders read null
            // as "brand-new user". Single source of truth, no fork.
            const firstSessionDaysAgo: number | null = oldestPlanned
              ? dateDiffDays(oldestPlanned, todayStr)
              : null;
            const daysSinceLast = newestPlanned
              ? dateDiffDays(newestPlanned, todayStr)
              : Number.POSITIVE_INFINITY;
            const gapDays = computeGapDays({
              firstSessionDaysAgo,
              totalCompleted: completedDates.length,
              daysSinceLast,
              trainingDays,
              trainedDays14,
            });

            // ── Effort zone — reuse the count from Promise.all. ──
            const ezForObs = effortZoneResult ?? { hits: 0, total: 0 };

            // ── Fatigue signals for the composite (synthesis) observations ──
            // The SAME numbers Training Status reads: repeated low-energy
            // sessions + RIR misses. lowEnergy over the last ~21 days using
            // the precise energy_score (≤2) with the legacy energy_level
            // fallback; RIR misses = rated sets outside the 1–2 zone.
            const obsIso21 = (() => {
              const d = new Date(todayDate); d.setDate(d.getDate() - 20);
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            let obsLowEnergySessions = 0;
            for (const s of completedDates as Array<{ planned_date: string; energy_level?: string | null; energy_score?: number | null }>) {
              if (!s.planned_date || s.planned_date < obsIso21) continue;
              const hasScore = s.energy_score != null;
              const isLow = hasScore ? (s.energy_score as number) <= 2 : s.energy_level === 'low';
              if (isLow) obsLowEnergySessions++;
            }
            const obsRirMissSets = Math.max(0, (ezForObs.total ?? 0) - (ezForObs.hits ?? 0));

            const observations = deriveObservations({
              todayIso: todayStr,
              liftSessions,
              // sessionPrs only on the workout-finish path.
              sessionPrs: [],
              trainedDays14,
              trainedDays28,
              blockWeek,
              effortZone: ezForObs,
              gapDays,
              todayWorkoutType: todayPlan?.workoutType ?? null,
              todayExerciseCount: Array.isArray(todayPlan?.exercises) ? todayPlan!.exercises.length : 0,
              // Cold-start fields. The plan_rationale + calibration
              // observations both auto-retire — plan_rationale by the
              // totalCompleted >= 8 guard, calibration by the
              // firstSessionDaysAgo >= 14 OR totalCompleted >= 6 guard.
              // Once real observations land (salience 0.7–1.0), the
              // selector also outranks both (0.55 / 0.6).
              split: profileData?.preferred_split ?? null,
              trainingDays: profileData?.training_days ?? null,
              firstSessionDaysAgo,
              totalCompleted: completedDates.length,
              // Fatigue co-occurrence signals → pushing_hard / grinding.
              lowEnergySessions: obsLowEnergySessions,
              rirMissSets: obsRirMissSets,
            });

            // ── Memory guard: recent factSigs from the trailing dedupKeys. ──
            // MAX_MESSAGES is 20; pulling the full list gives the selector
            // a full window without an extra read.
            const existing = await loadCoachMessages(user.id);
            const recentFactSigs = new Set<string>();
            for (const m of existing) {
              const fs = factSigFromDedupKey(m.dedupKey);
              if (fs) recentFactSigs.add(fs);
            }
            const picked = selectTopObservations(observations, { recentFactSigs, max: 2 });
            for (const obs of picked) {
              await appendCoachMessageOnce(
                user.id,
                dedupKeyFor(obs),
                { text: phraseObservation(obs), kind: 'observation' },
              );
            }

            // ── AI voice upgrade (deterministic-first, never blocks). ──
            // The deterministic line is already on the card by the time this
            // fires. runCoachVoiceUpgrade is a no-op when COACH_AI_VOICE is
            // false, and on its own internal errors. The upgraded text
            // surfaces on the NEXT focus — we deliberately don't update the
            // local React state from here so a mid-frame mutation can't
            // happen while the user is reading the card.
            const uid = user.id;
            // Composites are deterministic-only — they never go to the AI
            // rephraser (which only handles single facts). Filtering them keeps
            // coachVoiceAI on the narrower Observation type and untouched.
            const aiPicked = picked.filter((o): o is Observation => !isCompositeObservation(o));
            void runCoachVoiceUpgrade(uid, aiPicked, updateCoachMessageTextByFactSig);

            // Re-load so anything just appended surfaces on this focus.
            // Note: seen-clearing is now the Coach sub-tab's job, not the
            // dashboard's — we just push the latest list into state.
            const refreshed = await loadCoachMessages(user.id);
            setCoachMessages(refreshed);
          } catch (e) {
            reportSilent(e, 'home:coachObservations');
          }

          // ── Training Status (trend-based; src/lib/trainingStatus.ts) ────
          // A backward-looking read over the last ~2–3 weeks. NOT readiness:
          // there is no same-day input, so it can never penalize "trained
          // today." Drives the Training Status card AND the tap-to-accept
          // deload offer. Fully isolated try — a failure here must not affect
          // the coach card or the rest of the dashboard.
          try {
            // Block week: prefer today's PlanDay deload flag, else the cached
            // mesocycle position. null when neither is known (no deload math).
            let cachedBlockWeekTS: number | null = null;
            try {
              const rawCache = await AsyncStorage.getItem('plan:current');
              if (rawCache) {
                const bw = JSON.parse(rawCache)?.blockWeek;
                if (typeof bw === 'number' && bw >= 1 && bw <= 4) cachedBlockWeekTS = bw;
              }
            } catch (e) {
              reportSilent(e, 'home:trainingStatus:blockWeek');
            }
            const activeIsDeload = todayPlan?.deload === true;
            const statusBlockWeek: number | null = activeIsDeload ? 4 : cachedBlockWeekTS;

            // Trailing windows from the completed-session list (DESC by date).
            const tsSessions = (
              obsSessionsRes && !(obsSessionsRes as any).error
                ? ((obsSessionsRes as any).data ?? [])
                : []
            ) as Array<{ planned_date: string; energy_level: string | null; energy_score: number | null }>;
            const tsIso = (daysBack: number): string => {
              const d = new Date(todayDate);
              d.setDate(d.getDate() - daysBack);
              return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            };
            const win14 = tsIso(13);
            const win21 = tsIso(20);
            const distinctIn14 = new Set<string>();
            let lowEnergyIn21 = 0;
            let ratedEnergyIn21 = 0;
            for (const s of tsSessions) {
              if (!s?.planned_date) continue;
              if (s.planned_date >= win14) distinctIn14.add(s.planned_date);
              if (s.planned_date >= win21) {
                // Prefer the precise 1–5 energy_score (post-push sessions);
                // fall back to the legacy energy_level bucket for old rows.
                const hasScore = s.energy_score != null;
                const rated = hasScore || s.energy_level != null;
                if (rated) {
                  ratedEnergyIn21++;
                  const isLow = hasScore ? (s.energy_score as number) <= 2 : s.energy_level === 'low';
                  if (isLow) lowEnergyIn21++;
                }
              }
            }
            const tsTrainingDays = Math.max(0, Math.min(7, Math.floor(profileData?.training_days ?? 0)));

            // ── Sticky calibration unlock ─────────────────────────────────
            // The calibration gate keys off the LIFETIME completed count
            // (monotonic), not the recent window, so an established user in a
            // thin fortnight (deload/travel/illness) never reverts to
            // "Calibrating". Once the threshold is first met we persist a
            // sticky flag so the unlock also survives offline / a failed count
            // query (and reinstalls re-derive it from the server count). Only
            // the calibration-vs-live decision is sticky — the score below
            // still reads the recent window honestly.
            const lifetimeCompleted = (lifetimeCompletedRes as any)?.count ?? 0;
            const unlockKey = `recovery:unlocked:${user.id}`;
            let everUnlocked = false;
            try {
              everUnlocked = (await AsyncStorage.getItem(unlockKey)) === '1';
            } catch (e) {
              reportSilent(e, 'home:trainingStatus:unlockFlag');
            }
            if (!everUnlocked && lifetimeCompleted >= CALIBRATION_SESSIONS_NEEDED) {
              everUnlocked = true;
              AsyncStorage.setItem(unlockKey, '1').catch(() => { /* tolerated */ });
            }
            // Monotonic figure for the gate: the real lifetime count, floored
            // at the threshold once sticky-unlocked (covers an offline 0-count).
            const lifetimeForGate = everUnlocked
              ? Math.max(lifetimeCompleted, CALIBRATION_SESSIONS_NEEDED)
              : lifetimeCompleted;

            const status = computeTrainingStatus({
              liftDeltas: strengthTrendResult?.perLift ?? [],
              completedSessions: distinctIn14.size,
              // Sticky one-time onboarding gate — see above. Drives only the
              // calibration unlock, never the score.
              lifetimeCompletedSessions: lifetimeForGate,
              // Rolling ~2-week planned target (training days × 2 weeks). 0 when
              // the schedule is unknown → adherence treated as neutral.
              plannedSessions: tsTrainingDays * 2,
              lowEnergySessions: lowEnergyIn21,
              ratedEnergySessions: ratedEnergyIn21,
              ratedSets: effortZoneResult?.total ?? 0,
              rirMissSets: Math.max(0, (effortZoneResult?.total ?? 0) - (effortZoneResult?.hits ?? 0)),
            });
            setTrainingStatus(status);

            // Deload countdown for the explain copy + the offer decision.
            // deloadStart = weekStart + (4 − blockWeek)·7; days until then.
            let computedDeloadInDays: number | null = null;
            if (statusBlockWeek != null && statusBlockWeek < 4 && currentPlan.week_start) {
              const wp = currentPlan.week_start.split('-').map(Number);
              const deloadStart = new Date(wp[0], wp[1] - 1, wp[2] + (4 - statusBlockWeek) * 7);
              const tp = todayStr.split('-').map(Number);
              const todayMid = new Date(tp[0], tp[1] - 1, tp[2]);
              const d = Math.round((deloadStart.getTime() - todayMid.getTime()) / 86400000);
              computedDeloadInDays = d > 0 ? d : null;
            }
            setDeloadInDays(computedDeloadInDays);

            setDeloadOffer(
              decideDeloadOffer({
                state: status.state,
                blockWeek: statusBlockWeek,
                activeIsDeload,
              }),
            );
          } catch (e) {
            reportSilent(e, 'home:trainingStatus');
            setTrainingStatus(null);
            setDeloadOffer(null);
            setDeloadInDays(null);
          }

          // Stage today's session label for the widget. Workout days carry
          // the workoutType verbatim; rest days surface the literal "Rest"
          // so the widget renders the same vocabulary the dashboard does.
          widgetTodayType = todayPlan ? todayPlan.workoutType : 'Rest';

          // Today counts toward streak-protection only when it's an actual
          // planned training day (not a rest day).
          streakTodayIsTraining = !!todayPlan;
        }
      } else {
        setPlan(null);
        setPlanDays([]);
        setCompletedDayNames(new Set());
        setTrainingStatus(null);
        setDeloadOffer(null);
        setDeloadInDays(null);
        setEarlyWin({ liftsImproved: 0, show: false });
      }

      // Gap detection: surface absences and stranded past sessions.
      //
      // Two signals can fire the GapModal:
      //
      //   1. An unresolved past planned TRAINING day — any non-Rest,
      //      non-Recovery day across the last ~21 days of weekly_plans
      //      rows whose date < today and which has no completed
      //      non-recovery session on that exact date. This is the
      //      stranded-leg-day case and surfaces EVERY focus until the
      //      user picks resume (which shifts the day onto today) or
      //      reset (which regenerates a fresh week). The legacy "ack
      //      for the day" suppression is intentionally NOT honored
      //      here — a one-time dismissal must not strand the user on a
      //      stuck dashboard.
      //
      //   2. Legacy fallback: detectReturnGap >= 3 days since last
      //      completed session. Only consulted when no unresolved miss
      //      exists. Respects the per-day ack key as a secondary guard,
      //      but — like path 1 — is gated on the gap:resolvedThrough
      //      watermark, because ackGap writes only the watermark and a
      //      fallback-detected gap would otherwise re-fire every focus.
      //
      // For (1), `returnGap` is set to the days-since-earliest-miss so
      // the modal copy ("You missed N days of training") reads
      // honestly. Resume → cascade-shift; the next focus's scan finds
      // no unresolved miss and the modal stops firing.
      try {
        const surveyFrom = (() => {
          const p = todayStr.split('-').map(Number);
          const d = new Date(p[0], p[1] - 1, p[2] - 27);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        const surveyEnd = (() => {
          const p = todayStr.split('-').map(Number);
          const d = new Date(p[0], p[1] - 1, p[2] + 27);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();

        // The completions window MUST cover the full plan-survey window
        // (every planned date in a surveyed row is >= that row's week_start
        // >= surveyFrom). It used to start at today-21 while plans were
        // surveyed from today-27 — sessions completed 22–27 days ago fell
        // outside it and their planned days were counted as "missed",
        // inflating the backlog (the 3-instead-of-1 over-count).
        const [surveyRowsRes, completedRes] = await Promise.all([
          supabase
            .from('weekly_plans')
            .select('plan, week_start')
            .eq('user_id', user.id)
            .gte('week_start', surveyFrom)
            .lte('week_start', surveyEnd)
            .order('week_start', { ascending: true }),
          supabase
            .from('workout_sessions')
            .select('planned_date')
            .eq('user_id', user.id)
            .eq('completed', true)
            .eq('is_recovery', false)
            .gte('planned_date', surveyFrom)
            .lte('planned_date', todayStr),
        ]);

        const surveyRows = (surveyRowsRes.data ?? []) as Array<{ plan: any; week_start: string }>;
        const completedDates = new Set<string>(
          ((completedRes.data ?? []) as Array<{ planned_date: string }>)
            .map(r => r.planned_date)
            .filter(Boolean),
        );

        const rowsForScan = surveyRows.map(r => {
          const rawDays = Array.isArray(r.plan?.days)
            ? r.plan.days
            : Array.isArray(r.plan) ? r.plan : [];
          return { weekStart: r.week_start, planDays: rawDays };
        });

        // Watermark gate (Bug 1 fix). The catch-up rewrite only touches
        // rows from today forward, so a miss stranded in a past-week
        // row stays uncompleted forever in the DB. Without the
        // watermark, every focus re-counts the same miss and re-fires
        // the modal — an infinite "you missed N days" loop. The
        // watermark is "every planned date on or before this ISO has
        // been resolved (resumed or skipped)" — a NEW miss on a later
        // date still surfaces because its date is strictly after the
        // watermark.
        const resolvedThrough = await AsyncStorage.getItem(gapResolvedThroughKey(user.id));

        // Day-level gate shared by BOTH trigger paths. ackGap writes only
        // the watermark (never the legacy ack key), so the fallback path
        // must honor it too — otherwise a fallback-detected gap (e.g. a
        // long-dormant account with no unfinished days inside the survey
        // window) re-fires the modal on every focus after the user acts.
        if (shouldShowGapModalToday(todayStr, resolvedThrough)) {
          const anchor = findEarliestUnfinishedTrainingDay(
            rowsForScan,
            todayStr,
            completedDates,
            resolvedThrough,
          );

          if (anchor) {
            // Unresolved past training day past the watermark — fire the
            // modal. Both resume and skip set the watermark before
            // returning so this scenario doesn't loop.
            setReturnGap(anchor.offsetDays);
            setShowGapModal(true);
            // Funnel: the user is being offered a replan/catch-up choice.
            // replan_accepted fires from ackGap on the user's tap; the
            // offered/accepted pair gives a step-to-step rate.
            track('replan_offered', {
              replan_source: 'unfinished_anchor',
              offset_days: anchor.offsetDays,
            });
          } else {
            // No stranded miss — fall back to the legacy "days since last
            // completed session" signal for the still-onboarding case.
            // The per-day ack key remains as a secondary guard, but the
            // watermark gate above is what stops the post-ackGap loop.
            const gap = await detectReturnGap(user.id);
            if (gap >= 3) {
              const ackKey = `intr:gapAck:${user.id}:${gap}:${todayStr}`;
              const alreadyAcked = await AsyncStorage.getItem(ackKey);
              if (!alreadyAcked) {
                setReturnGap(gap);
                setShowGapModal(true);
                track('replan_offered', { replan_source: 'return_gap', gap_days: gap });
              }
            }
          }
        }
      } catch (e) {
        // Gap detection fails silently
        reportSilent(e, 'home:gapDetection');
      }

      // Widget bridge: stage today's session + streak for the home-screen
      // widget to read. Fire-and-forget; placed on the success path (NOT in
      // finally) so a fetch failure leaves the last-good widget values in
      // place rather than overwriting them with zeros.
      void setWidgetData({
        todayWorkoutType: widgetTodayType,
        streakCount: streakResult?.current ?? 0,
        updatedAt: new Date().toISOString(),
      });

      // Streak-protection nudge — one warm, non-shaming evening reminder when
      // an active streak is at risk (today's planned session still undone).
      // Fire-and-forget; the helper itself respects the permission/setting
      // gate and cancels any prior streak nudge so it never nags. Reschedules
      // each focus, so finishing today's session clears the pending nudge.
      void syncStreakProtectionNotification({
        currentStreak: streakResult?.current ?? 0,
        todayIsPlannedTraining: streakTodayIsTraining,
        todayCompleted: todayDoneLocal,
      });

    } catch (e) {
      // Dashboard fetch failed silently — user can retry by switching tabs
    } finally {
      setLoading(false);
    }
  };

  const username = profile?.username || 'Athlete';
  const initial = username.charAt(0).toUpperCase();

  const ackGap = async (action: 'resume' | 'skip') => {
    setGapActionLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      // Both actions go through the SAME generator-based forward build
      // (buildCatchUpRows). They differ only in:
      //
      //   resume → backlogN = M_missed,
      //            mesocyclePosition = mesocyclePosition  (make up the misses
      //            back-to-back, then return to cadence)
      //
      //   skip   → backlogN = 0,
      //            mesocyclePosition = mesocyclePosition + M_missed  (advance
      //            past the missed sessions; today = the canonical NEXT
      //            session after them, on normal cadence)
      //
      // Either way, the block/deload position and the user's accumulated
      // mesocycle progress are preserved — skip does NOT restart the plan.
      //
      // After the rewrite, both paths set a `gap:resolvedThrough` watermark
      // = today's ISO. The next focus's scan ignores any planned date ≤
      // that watermark, so the modal stops re-firing on this miss but a
      // genuinely new miss on a later date still counts.
      //
      // Idempotent: if the scan finds nothing past the watermark, the
      // builder is still called with backlogN=0; that produces a normal-
      // cadence horizon (a no-op vs. what ensureCurrentWeekPlan would
      // produce), but we skip persistence when there's nothing to do.
        const surveyFrom = (() => {
          const p = todayStr.split('-').map(Number);
          const d = new Date(p[0], p[1] - 1, p[2] - 27);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        const surveyEnd = (() => {
          const p = todayStr.split('-').map(Number);
          const d = new Date(p[0], p[1] - 1, p[2] + 27);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        // Pull plan rows for the unfinished-day scan + completed-session
        // dates for the SAME window (a completions window narrower than the
        // plan survey makes old completed days look "missed" and inflates
        // the backlog) + profile inputs + the mesocycle anchor.
        const [surveyRowsRes, completedRes, profileRes, anchorRowRes, totalCompletedRes, priorPlansRes] = await Promise.all([
          supabase
            .from('weekly_plans')
            .select('plan, week_start')
            .eq('user_id', user.id)
            .gte('week_start', surveyFrom)
            .lte('week_start', surveyEnd)
            .order('week_start', { ascending: true }),
          supabase
            .from('workout_sessions')
            .select('planned_date')
            .eq('user_id', user.id)
            .eq('completed', true)
            .eq('is_recovery', false)
            .gte('planned_date', surveyFrom)
            .lte('planned_date', todayStr),
          supabase
            .from('profiles')
            .select('training_days, preferred_split, fitness_level')
            .eq('id', user.id)
            .maybeSingle(),
          supabase
            .from('weekly_plans')
            .select('week_start')
            .eq('user_id', user.id)
            .order('week_start', { ascending: true })
            .limit(1)
            .maybeSingle(),
          // mesocyclePosition = count of completed non-recovery sessions
          // ever. This is the rotation phase to pass to generatePlan.
          // The PPL "you missed legs → next is push" property holds as
          // long as the count reflects what the rotation expects.
          supabase
            .from('workout_sessions')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .eq('completed', true)
            .eq('is_recovery', false),
          supabase
            .from('weekly_plans')
            .select('plan')
            .eq('user_id', user.id)
            .lt('week_start', todayStr)
            .order('week_start', { ascending: false })
            .limit(4),
        ]);

      const surveyRows = (surveyRowsRes.data ?? []) as Array<{ plan: any; week_start: string }>;
      const completedDates = new Set<string>(
        ((completedRes.data ?? []) as Array<{ planned_date: string }>)
          .map(r => r.planned_date)
          .filter(Boolean),
      );
      const rowsForScan = surveyRows.map(r => {
        const rawDays = Array.isArray(r.plan?.days)
          ? r.plan.days
          : Array.isArray(r.plan) ? r.plan : [];
        return { weekStart: r.week_start, planDays: rawDays };
      });

      // Honor a prior watermark — re-pressing the same button shouldn't
      // re-count already-resolved past misses (idempotency).
      const priorWatermark = await AsyncStorage.getItem(gapResolvedThroughKey(user.id));
      const missedCount = countUnfinishedPastTrainingDays(
        rowsForScan,
        todayStr,
        completedDates,
        priorWatermark,
      );

      if (missedCount > 0) {
        const profile = profileRes.data as { training_days: number | null; preferred_split: string | null; fitness_level: string | null } | null;
        const trainingDays = (profile?.training_days && profile.training_days > 0)
          ? profile.training_days
          : 3;
        const fitnessLevel = (profile?.fitness_level as 'beginner' | 'intermediate' | 'advanced') ?? 'beginner';
        const storedLoc = await AsyncStorage.getItem('user:defaultLocation');
        const location: 'gym' | 'home' = storedLoc === 'Home' ? 'home' : 'gym';

        // Block math from the user's plan anchor.
        const blockAnchor = (anchorRowRes.data?.week_start as string | undefined) ?? todayStr;
        const weeksFromAnchorToToday = (() => {
          const a = blockAnchor.split('-').map(Number);
          const b = todayStr.split('-').map(Number);
          const da = new Date(a[0], a[1] - 1, a[2]).getTime();
          const db = new Date(b[0], b[1] - 1, b[2]).getTime();
          return Math.max(0, Math.round((db - da) / 86400000 / 7));
        })();
        const blockIndex = Math.floor(weeksFromAnchorToToday / 4);
        const blockWeek = (weeksFromAnchorToToday % 4) + 1;

        const completedCount = (totalCompletedRes as any).count ?? 0;

        // Plan history (last 4 weeks before today) for the generator's
        // variety scoring. Stored as { exercises: string[] }.
        const planHistory = (priorPlansRes.data ?? []).map((row: any) => {
          const days = Array.isArray(row?.plan?.days)
            ? row.plan.days
            : Array.isArray(row?.plan) ? row.plan : [];
          const names: string[] = [];
          for (const d of days) {
            if (Array.isArray(d?.exercises)) {
              for (const ex of d.exercises) if (ex?.name) names.push(ex.name);
            }
          }
          return { exercises: names };
        }).filter((h: any) => h.exercises.length > 0);

        // The two actions: resume makes up missed sessions back-to-back;
        // skip advances past them in the canonical rotation. Same
        // generator, different (backlogN, mesocyclePosition) inputs.
        const backlogN = action === 'resume' ? missedCount : 0;
        const mesocyclePosition = action === 'resume'
          ? completedCount
          : completedCount + missedCount;

        const { rows: catchUpRows } = buildCatchUpRows({
          todayIso: todayStr,
          backlogN,
          mesocyclePosition,
          trainingDays,
          fitnessLevel,
          location,
          // Keep the user's explicit split on resume/skip (resolveSplit in the
          // generator guards an invalid/legacy value).
          split: (profile?.preferred_split ?? undefined) as SplitId | undefined,
          planHistory,
          blockIndex,
          blockWeek,
          // Stable 7-day grid pinned to the user's plan anchor so two
          // catch-up runs on different weekdays produce IDENTICAL row
          // boundaries (no partially-overlapping rows that map the
          // same calendar date to two workout types).
          gridAnchor: blockAnchor,
        });

        // Clear-before-rewrite: delete any row whose [week_start,
        // week_start+6] window touches today or later — not just rows
        // with week_start >= today. A row anchored at today-3 still
        // covers today through today+3 and must be removed, otherwise
        // it survives alongside our new today-anchored row and the
        // overlap silently maps today through today+3 to TWO different
        // workout types. The math: week_start + 6 >= today ⇔
        // week_start >= today - 6.
        const cutoff = (() => {
          const p = todayStr.split('-').map(Number);
          const d = new Date(p[0], p[1] - 1, p[2] - 6);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        const oldStarts = surveyRows
          .filter(r => r.week_start >= cutoff)
          .map(r => r.week_start);
        if (oldStarts.length > 0) {
          const { error: deleteError } = await supabase
            .from('weekly_plans')
            .delete()
            .eq('user_id', user.id)
            .in('week_start', oldStarts);
          if (deleteError) {
            console.warn(`[home] weekly_plans ${action}-catchUp delete failed`, deleteError);
            Sentry.captureException(deleteError);
          }
        }

        let cacheDaysForActive: any[] | null = null;
        let cacheWeekStartForActive: string | null = null;
        for (const row of catchUpRows) {
          if (row.planDays.length === 0) continue;
          const { error: upsertError } = await supabase.from('weekly_plans').upsert(
            { user_id: user.id, week_start: row.weekStart, plan: row.planDays, plan_version: CURRENT_PLAN_VERSION },
            { onConflict: 'user_id,week_start' },
          );
          if (upsertError) {
            console.warn(`[home] weekly_plans ${action}-catchUp upsert failed`, upsertError);
            Sentry.captureException(upsertError);
          }
          // The active row is the one whose [weekStart, weekStart+6]
          // window CONTAINS today — after grid alignment today is no
          // longer guaranteed to equal row.weekStart.
          const wp = row.weekStart.split('-').map(Number);
          const wend = new Date(wp[0], wp[1] - 1, wp[2] + 6);
          const wendStr = `${wend.getFullYear()}-${String(wend.getMonth() + 1).padStart(2, '0')}-${String(wend.getDate()).padStart(2, '0')}`;
          if (row.weekStart <= todayStr && todayStr <= wendStr) {
            cacheDaysForActive = row.planDays;
            cacheWeekStartForActive = row.weekStart;
          }
        }

        if (cacheDaysForActive && cacheWeekStartForActive) {
          // Stamp blockWeek into plan:current so the dashboard's
          // buildBlockPosition observation can fire after a skip/resume.
          // Without this stamp the dashboard reads cache.blockWeek = null
          // and the deload/Week-N signal silently disappears. We use the
          // same calendar-week math planSync uses (anchor row is captured
          // BEFORE the upsert above and is preserved across the
          // delete-then-upsert because the delete is scoped to
          // week_start >= today while the anchor row is the EARLIEST row
          // overall — typically strictly before today).
          await AsyncStorage.setItem(
            'plan:current',
            JSON.stringify({
              generatedAt: new Date().toISOString(),
              weekStart: cacheWeekStartForActive,
              blockWeek,
              days: cacheDaysForActive,
            })
          );
        }
      }

      // Always set the watermark — even on missedCount === 0 — so a
      // stale modal opened from a prior focus doesn't keep nagging.
      // The watermark is "every planned date on or before today is
      // resolved." A NEW miss on a later date still counts because
      // it falls strictly after the watermark.
      await AsyncStorage.setItem(gapResolvedThroughKey(user.id), todayStr);

      // Funnel close: the user took the offer. replan_offered fires
      // when the modal opens (see fetchDashboardData); replan_accepted
      // fires here on EITHER button press (resume = make up missed,
      // skip = advance past on cadence). Both are an accept of the
      // catch-up prompt — the modal closing without a press would
      // be a drop, which the absence of this event reflects.
      track('replan_accepted', { replan_action: action });

      setShowGapModal(false);
      fetchDashboardData();
    } catch (e) {
      // Non-fatal; just close
      reportSilent(e, 'home:gapModalAction');
      setShowGapModal(false);
    } finally {
      setGapActionLoading(false);
    }
  };

  // ── Tap-to-accept deload actions (Training Status → deload) ───────────
  // Both rewrite ONLY the active-week row, fire-and-forget. A failed write
  // reports to Sentry and leaves the existing plan in place — it can never
  // break the dashboard or a workout. Survives ensureCurrentWeekPlan's
  // self-heal by construction: the heal compares (date, workoutType) pairs
  // only (weekRowMatchesCanonical), and a deload changes neither — see
  // src/lib/planDeload.ts. Future rows stay satisfied via the
  // CURRENT_PLAN_VERSION re-stamp.
  //
  //   'early' → applyDeloadToRows  (pull the deload forward to this week)
  //   'skip'  → clearDeloadFromRows (un-deload the scheduled week-4 row)
  const applyDeloadAction = async (action: 'early' | 'skip') => {
    setDeloadActionLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const cutoff = (() => {
        const p = todayStr.split('-').map(Number);
        const d = new Date(p[0], p[1] - 1, p[2] - 6);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      })();

      // The row covering today (week_start <= today <= week_start+6).
      const { data: rows } = await supabase
        .from('weekly_plans')
        .select('week_start, plan')
        .eq('user_id', user.id)
        .gte('week_start', cutoff)
        .lte('week_start', todayStr)
        .order('week_start', { ascending: false })
        .limit(1);

      const activeRow = rows && rows.length > 0 ? rows[0] : null;
      if (!activeRow) return;

      const planRow: DeloadPlanRowLike = {
        weekStart: activeRow.week_start,
        days: extractDeloadPlanDays(activeRow.plan),
      };
      const { changedRows } =
        action === 'early'
          ? applyDeloadToRows({ rows: [planRow], todayIso: todayStr })
          : clearDeloadFromRows({ rows: [planRow], todayIso: todayStr });

      if (changedRows.length > 0) {
        const changed = changedRows[0];
        const { error: upsertError } = await supabase.from('weekly_plans').upsert(
          {
            user_id: user.id,
            week_start: changed.weekStart,
            plan: changed.days,
            plan_version: CURRENT_PLAN_VERSION,
          },
          { onConflict: 'user_id,week_start' },
        );
        if (upsertError) {
          reportSilent(upsertError, 'home:deloadAction:upsert');
        } else {
          // Keep the plan:current cache in step so the workout screen reads
          // the new (de)deloaded volume immediately, without a refetch race.
          try {
            const rawCache = await AsyncStorage.getItem('plan:current');
            const cache = rawCache ? JSON.parse(rawCache) : {};
            await AsyncStorage.setItem(
              'plan:current',
              JSON.stringify({
                ...cache,
                generatedAt: new Date().toISOString(),
                weekStart: changed.weekStart,
                days: changed.days,
              }),
            );
          } catch (e) {
            reportSilent(e, 'home:deloadAction:cache');
          }
          track('deload_action', { deload_action: action });
        }
      }

      setDeloadOffer(null);
      fetchDashboardData();
    } catch (e) {
      // Fire-and-forget: never breaks the dashboard.
      reportSilent(e, 'home:deloadAction');
    } finally {
      setDeloadActionLoading(false);
    }
  };

  const daysLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  // ── Card presentation (derived from state; pure render helpers) ───────
  // Rest day = no training planned today. On a rest day the streak is being
  // MAINTAINED, not about to break, so the Consistency number drops the fiery
  // coral for a calm neutral — no "Duolingo about to break" alarm.
  const isRestToday = !plan || plan.today_type !== 'workout';
  const streakColor = isRestToday ? colors.textSecondary : colors.accentCoral;

  // Momentum → "This month": workouts completed vs the month's planned target
  // as a percentage headline, raw count as context. Empty state (no completed
  // session this month yet) reads "—" / "Building" — never a misleading "0%".
  const monthView = (() => {
    const { completedCount, plannedCount, percentage } = monthlyConsistency;
    if (completedCount > 0 && plannedCount > 0) {
      return { value: `${percentage}%`, sub: `${completedCount} of ${plannedCount} sessions` };
    }
    return { value: '—', sub: 'Building' };
  })();

  // Training Status card: dot color + label per state; reason references a
  // scheduled deload when the trend is flat/declining (the "explain" copy).
  const statusView = (() => {
    switch (trainingStatus?.state) {
      case 'recovering_well': return { color: colors.accentPositive, label: 'RECOVERING WELL' };
      case 'holding_steady': return { color: colors.accentAmber, label: 'HOLDING STEADY' };
      case 'backing_off': return { color: colors.accentRed, label: 'BACKING OFF' };
      default: return { color: colors.textMuted, label: 'CALIBRATING' };
    }
  })();
  const statusReason = (() => {
    const base = trainingStatus?.reason ?? 'Building your baseline — keep logging your sessions.';
    // Explain: only mention an upcoming deload on a flat/declining trend, so
    // a strong week doesn't get a "deload soon" nag.
    const wantsNote =
      trainingStatus?.state === 'backing_off' || trainingStatus?.state === 'holding_steady';
    const note = wantsNote ? deloadProximityNote(deloadInDays) : null;
    return note ? `${base} ${note}` : base;
  })();

  // Calibration progress for the locked recovery card. Reads the SAME inputs
  // the engine scored, so `unlocked` flips in lockstep with score going
  // non-null — the card can't show a countdown the gauge has already passed.
  const calibration = trainingStatus ? computeCalibration(trainingStatus.inputs) : null;

  // Early small-win line. Shown only while the strength trend is still thin
  // (the calibration window) AND there's a real, recent "added weight" event —
  // once the recent-vs-prior trend is robust, the gauge + coach carry it and
  // this retires. `earlyWin.show` is false on a fresh account, so nothing
  // renders until there's an honest win.
  const trendIsThin = (strengthTrend.exercisesCompared ?? 0) < 2;
  const showEarlyWin = !loading && earlyWin.show && trendIsThin;
  const earlyWinText = earlyWin.liftsImproved === 1
    ? 'You added weight on 1 lift this week.'
    : `You added weight on ${earlyWin.liftsImproved} lifts this week.`;

  return (
    <View style={styles.screenWrapper}>
      {/* Gap-resolution modal. Surfaces whenever an unresolved past
          planned training day exists; resolved either by making the
          missed sessions up (resume) or by skipping ahead to the next
          canonical session on normal cadence (skip). After either
          press, a watermark (gap:resolvedThrough:<uid>) is written so
          this same miss never re-fires the modal. */}
      <Modal visible={showGapModal} transparent animationType="fade" onRequestClose={() => setShowGapModal(false)}>
        <View style={styles.gapModalOverlay}>
          <View style={styles.gapModalCard}>
            <Text style={styles.gapModalEyebrow}>WELCOME BACK</Text>
            <Text style={styles.gapModalTitle}>
              You missed {returnGap} {returnGap === 1 ? 'day' : 'days'} of training.
            </Text>
            <Text style={styles.gapModalBody}>
              Make up the missed sessions back-to-back, or skip ahead and continue on schedule. Either way, today's a session.
            </Text>
            <Button
              title="Pick up where I left off"
              onPress={() => ackGap('resume')}
              loading={gapActionLoading}
              style={{ marginTop: layout.spacing.lg }}
            />
            <Button
              title="Skip ahead"
              variant="ghost"
              onPress={() => ackGap('skip')}
              disabled={gapActionLoading}
              style={{ marginTop: layout.spacing.sm }}
            />
          </View>
        </View>
      </Modal>

      {/* (Legacy MissedModal removed. The GapModal above handles every
          stranded past training day — within-week or across-week — via
          the catch-up pack regenerated by ackGap('resume').) */}

      {/* Forward 30-day modal — tapping the WeekStrip expands into this.
          Read-only forward view starting today. No past, no navigation, no
          fabrication: days past the latest stored plan render as 'unknown'. */}
      <Modal visible={showMonthModal} transparent animationType="fade" onRequestClose={() => setShowMonthModal(false)}>
        <View style={styles.gapModalOverlay}>
          <View style={[styles.gapModalCard, { padding: layout.spacing.lg, maxHeight: '85%' }]}>
            <Text style={styles.gapModalEyebrow}>NEXT 30 DAYS</Text>
            <Text style={[styles.gapModalTitle, { marginBottom: layout.spacing.md }]}>
              Your plan, looking forward.
            </Text>

            <ScrollView
              style={{ maxHeight: 420 }}
              showsVerticalScrollIndicator={false}
            >
              {forwardLoading && forwardDays.length === 0 ? (
                <Text style={styles.monthLoadingText}>Loading…</Text>
              ) : forwardDays.length === 0 ? (
                <Text style={styles.monthLoadingText}>No plan yet.</Text>
              ) : (
                forwardDays.map((day, i) => {
                  const isSelected = selectedForwardDay?.date === day.date;
                  const tappable = day.state !== 'unknown' && day.state !== 'rest';
                  return (
                    <TouchableOpacity
                      key={i}
                      style={[styles.forwardRow, isSelected && styles.forwardRowSelected]}
                      onPress={() => tappable ? setSelectedForwardDay(day) : null}
                      activeOpacity={tappable ? 0.6 : 1}
                      disabled={!tappable}
                    >
                      {/* Date column */}
                      <View style={styles.forwardDateCol}>
                        <Text style={[styles.forwardWeekday, day.isToday && styles.forwardTodayText]}>
                          {day.isToday ? 'TODAY' : day.weekdayShort.toUpperCase()}
                        </Text>
                        <Text style={[styles.forwardDateNum, day.isToday && styles.forwardTodayText]}>
                          {day.monthShort} {day.dayOfMonth}
                        </Text>
                      </View>

                      {/* Dot — mirrors WeekStrip vocabulary */}
                      <View style={styles.forwardDotWrap}>
                        {day.state === 'completed' && <View style={styles.monthDotCompleted} />}
                        {day.state === 'planned' && <View style={styles.monthDotRing} />}
                        {day.state === 'rest' && <View style={styles.monthDotRest} />}
                        {/* 'unknown' → no dot */}
                      </View>

                      {/* Workout label */}
                      <Text style={styles.forwardWorkoutLabel} numberOfLines={1}>
                        {day.workoutType
                          ? day.workoutType
                          : day.state === 'rest'
                            ? 'Rest'
                            : day.state === 'completed'
                              ? 'Completed'
                              : '—'}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>

            {/* Selected-day summary (read-only). */}
            {selectedForwardDay ? (
              <View style={styles.monthDaySummary}>
                <Text style={styles.gapModalEyebrow}>
                  {selectedForwardDay.date} · {selectedForwardDay.state.toUpperCase()}
                </Text>
                <Text style={styles.gapModalBody}>
                  {selectedForwardDay.workoutType
                    ? selectedForwardDay.workoutType
                    : selectedForwardDay.state === 'rest'
                      ? 'Rest day.'
                      : 'No workout planned.'}
                </Text>
              </View>
            ) : null}

            <Button
              title="Close"
              variant="ghost"
              onPress={() => setShowMonthModal(false)}
              style={{ marginTop: layout.spacing.lg }}
            />
          </View>
        </View>
      </Modal>

      <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          <View style={styles.header}>
            <View>
              {loading ? <Skeleton width={150} height={28} colors={colors} /> : (
                <Text
                  style={styles.greeting}
                  // Dev-only Sentry smoke test. Long-press the greeting in a
                  // debug build to throw a known error through reportSilent so
                  // we can confirm events are landing in the Sentry dashboard.
                  // __DEV__ gates this off in release builds — production
                  // users can never trigger it. Removable once the DSN is
                  // verified, but cheap to leave in place for future audits.
                  onLongPress={
                    __DEV__
                      ? () => {
                          try {
                            throw new Error('[Sentry smoke test] long-press greeting in __DEV__');
                          } catch (e) {
                            reportSilent(e, 'devTrigger:greetingLongPress', { manual: true });
                          }
                        }
                      : undefined
                  }
                >
                  {greeting},{"\n"}{username}
                </Text>
              )}
            </View>
            <View style={styles.avatar}>
              {loading ? <Skeleton width={48} height={48} borderRadius={layout.smRadius} colors={colors} /> : (
                <Text style={styles.avatarText}>{initial}</Text>
              )}
            </View>
          </View>

          {/* Coach card — slim teaser for the most recent coach message.
              Tap routes to the Coach sub-tab where the full history lives.
              Renders nothing when the store is empty. */}
          {coachMessages.length > 0 && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => goToSubTab(COACH_SUB_TAB_INDEX)}
              style={styles.coachCard}
              accessibilityRole="button"
              accessibilityLabel={`Coach: ${coachMessages[0].text} — tap to open coach history`}
            >
              <View style={styles.coachCardHeader}>
                <Text style={styles.coachCardKicker}>COACH</Text>
                {latestUnseen(coachMessages) && (
                  <View style={styles.coachCardDot} accessibilityLabel="new" />
                )}
              </View>
              {/* 4 lines: campaign-status messages are up to four short
                  lines and the deload countdown is the last one. */}
              <Text style={styles.coachCardLatest} numberOfLines={4}>
                {coachMessages[0].text}
              </Text>
              <Text style={styles.coachCardFooter}>View all →</Text>
            </TouchableOpacity>
          )}


          {/* TODAY — feature card, leads the screen */}
          {loading ? (
            <View style={styles.todayFeature}>
              <Skeleton width="40%" height={11} colors={colors} />
              <Skeleton width="70%" height={26} style={{ marginTop: 10 }} colors={colors} />
              <Skeleton width="100%" height={48} borderRadius={layout.cardRadius} style={{ marginTop: 18 }} colors={colors} />
            </View>
          ) : (!plan || plan.days_planned === 0) ? (
            <View style={styles.todayFeature}>
              <Text style={styles.todayKicker}>BUILDING YOUR WEEK</Text>
              <Text style={styles.todayHeadline}>One moment.</Text>
              <Text style={styles.todayMeta}>We're putting together your plan from your profile.</Text>
              {/* No-plan dead-end recovery: route into /workout, which falls
                  through to its no-plan / ad-hoc screen so the user can
                  start something while the planner catches up. Understated
                  text link — doesn't undercut the "we're building it" beat. */}
              <TouchableOpacity
                onPress={() => router.push('/workout')}
                activeOpacity={0.6}
                hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
                style={styles.todayInlineLinkWrap}
                accessibilityRole="button"
                accessibilityLabel="Train anyway — pick an ad-hoc session"
              >
                <Text style={styles.todayInlineLink}>Train anyway →</Text>
              </TouchableOpacity>
            </View>
          ) : plan.today_type === 'rest' ? (
            <View style={styles.todayFeature}>
              <Text style={styles.todayKicker}>TODAY · REST</Text>
              <Text style={styles.todayHeadline}>Take the day.</Text>
              <Text style={styles.todayMeta}>
                {plan.next_workout_label && plan.next_workout_name
                  ? `Next: ${plan.next_workout_name} · ${plan.next_workout_label}`
                  : 'Recovery is part of the work. Come back tomorrow.'}
              </Text>
              {/* "Active recovery" — outlined ghost button using the
                  accentPositive token (the same green used for the RIR
                  "Easy" chip). Reads as a soft training option, not a
                  primary CTA, so the "take the day" message still leads.
                  Routes to the dedicated /recovery screen (recovery-
                  session generator), NOT the ad-hoc Push/Pull picker. */}
              <TouchableOpacity
                onPress={() => router.push('/recovery')}
                activeOpacity={0.75}
                style={styles.recoveryGhostBtn}
                accessibilityRole="button"
                accessibilityLabel="Active recovery — mobility and prehab session"
              >
                <Text style={styles.recoveryGhostBtnText}>Active recovery</Text>
              </TouchableOpacity>
            </View>
          ) : isTodayDone ? (
            <View style={styles.todayFeature}>
              <Text style={[styles.todayKicker, { color: colors.accentTeal }]}>DONE · {(plan.today_workout_name || '').toUpperCase()}</Text>
              <Text style={styles.todayHeadline}>Session logged.</Text>
              <Text style={styles.todayMeta}>
                {plan.next_workout_label && plan.next_workout_name && plan.next_workout_label !== 'Today'
                  ? `Next: ${plan.next_workout_name} · ${plan.next_workout_label}`
                  : "Recover well. Next one's already on the plan."}
              </Text>
            </View>
          ) : (
            <View style={[styles.todayFeature, styles.todayFeatureActive]}>
              <Text style={styles.todayKicker}>TODAY · {(plan.today_workout_name || '').toUpperCase()}</Text>
              <Text style={styles.todayHeadline}>{plan.today_workout_name}</Text>
              <Text style={styles.todayMeta}>{plan.today_duration} min estimated</Text>
              <Button
                title="Start workout"
                onPress={() => router.push('/workout')}
                style={{ marginTop: layout.spacing.lg }}
              />
            </View>
          )}

          {/* RECOVERY — the premium full-width gauge. Sage-tinted to set the
              "healing" half apart from the "lifting" momentum card below.
              Two faces, switched on whether the read has unlocked:

              • LOCKED (score null): a calibration view that frames the wait as
                an unlock the user is progressing toward. The countdown is
                derived from computeCalibration — the SAME signal gate the
                engine uses to leave 'unknown' — so it can never finish before
                or after the live gauge actually appears.
              • UNLOCKED (score set): the softly pulsing state dot + the big
                0–100 score + band label, with the measured reason alongside.

              Only shown with an active plan to read. */}
          {!loading && trainingStatus && calibration && !calibration.unlocked ? (
            <View style={styles.recoveryCard}>
              <View style={styles.recoveryRow}>
                <View style={styles.recoveryLeft}>
                  <PulseDot color={colors.accentTeal} />
                  <Text style={[styles.recoveryScore, styles.recoveryScoreBuilding]} numberOfLines={1} adjustsFontSizeToFit>
                    Calibrating
                  </Text>
                  <Text style={[styles.recoveryBandLabel, { color: colors.textMuted }]} numberOfLines={2}>
                    {calibration.remaining === 1
                      ? '1 SESSION TO GO'
                      : `${calibration.remaining} SESSIONS TO GO`}
                  </Text>
                </View>

                <View style={styles.recoveryRight}>
                  <Text style={styles.recoveryKicker}>RECOVERY</Text>
                  <Text style={styles.recoveryReason}>
                    {calibration.remaining === 1
                      ? 'Your coach is calibrating — 1 session to go before it reads your recovery.'
                      : `Your coach is calibrating — ${calibration.remaining} sessions to go before it reads your recovery.`}
                  </Text>
                  {/* Progress toward the unlock — fills as real logged sessions
                      accrue (1/3 → 2/3 → full). Reaches 100% on the exact focus
                      the gauge takes over. */}
                  <View style={styles.calibrationTrack}>
                    <View
                      style={[
                        styles.calibrationFill,
                        {
                          width: `${Math.round(
                            (calibration.sessionsLogged / Math.max(1, calibration.sessionsNeeded)) * 100,
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                </View>
              </View>
            </View>
          ) : !loading && trainingStatus ? (
            <View style={styles.recoveryCard}>
              <View style={styles.recoveryRow}>
                <View style={styles.recoveryLeft}>
                  <PulseDot color={statusView.color} />
                  <Text style={[styles.recoveryScore, { color: statusView.color }]} numberOfLines={1} adjustsFontSizeToFit>
                    {trainingStatus.score}
                  </Text>
                  <Text style={[styles.recoveryBandLabel, { color: statusView.color }]} numberOfLines={2}>
                    {statusView.label}
                  </Text>
                </View>

                <View style={styles.recoveryRight}>
                  <Text style={styles.recoveryKicker}>RECOVERY</Text>
                  <Text style={styles.recoveryReason}>{statusReason}</Text>
                </View>
              </View>

              {deloadOffer === 'early' && (
                <Button
                  title="Deload early?"
                  onPress={() => applyDeloadAction('early')}
                  loading={deloadActionLoading}
                  style={{ marginTop: layout.spacing.md }}
                />
              )}
              {deloadOffer === 'skip' && (
                <Button
                  title="Skip deload, keep pushing?"
                  variant="ghost"
                  onPress={() => applyDeloadAction('skip')}
                  disabled={deloadActionLoading}
                  style={{ marginTop: layout.spacing.md }}
                />
              )}
            </View>
          ) : null}

          {/* EARLY WIN — a small, honest reassurance during the calibration
              window: the count of lifts the user added weight on recently.
              Complements the coach's specific lift_progression line (which
              names one lift) without restating it the same way. Renders only
              when there's a real win and the trend is still thin. */}
          {showEarlyWin && (
            <View style={styles.earlyWinPill}>
              <View style={styles.earlyWinDot} />
              <Text style={styles.earlyWinText} numberOfLines={2}>{earlyWinText}</Text>
            </View>
          )}

          {/* MOMENTUM — one full-width card, split by a subtle internal
              divider. Left = Consistency (streak + this-week), calm/neutral on
              a rest day so a maintained streak never reads as "about to break".
              Right = This-month completion % (calculateMonthlyConsistency,
              fetched in fetchDashboardData) with the raw count as context.
              Honest "—"/"Building" empties — never a misleading "0%". */}
          {!loading && (
            <View style={styles.momentumCard}>
              <View style={styles.momentumHalf}>
                <Text style={styles.momentumKicker}>CONSISTENCY</Text>
                <Text
                  style={[styles.momentumValue, { color: streakColor }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {streak.current > 0 ? `${streak.current}` : '—'}
                </Text>
                <Text style={styles.momentumLabel}>
                  {streak.current > 0 ? 'day streak' : 'no streak yet'}
                </Text>
                <Text style={styles.momentumSub}>
                  {plan && plan.days_planned > 0
                    ? `This week: ${plan.days_completed} of ${plan.days_planned}`
                    : 'No plan yet'}
                </Text>
              </View>

              <View style={styles.momentumDivider} />

              <View style={styles.momentumHalf}>
                <Text style={styles.momentumKicker}>THIS MONTH</Text>
                <Text
                  style={[styles.momentumValue, { color: colors.accentTeal }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {monthView.value}
                </Text>
                <Text style={styles.momentumLabel} numberOfLines={1}>
                  {monthView.sub}
                </Text>
              </View>
            </View>
          )}

          {/* WEEK PROGRESS — tap to expand the full plan */}
          {!loading && plan && plan.days_planned > 0 && (
            <View style={styles.weekRow}>
              <TouchableOpacity
                style={styles.weekRowHeader}
                onPress={toggleWeek}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.weekRowLabel}>Week in progress</Text>
                  <Text style={styles.weekRowMeta}>{plan.days_completed} of {plan.days_planned} days</Text>
                  <View style={[styles.progressBarBg, { marginTop: 8 }]}>
                    <View style={[styles.progressBarFill, { width: `${(plan.days_completed / plan.days_planned) * 100}%` }]} />
                  </View>
                </View>
                <Text
                  style={[
                    styles.weekRowChevron,
                    { transform: [{ rotate: weekExpanded ? '90deg' : '0deg' }] },
                  ]}
                >
                  ›
                </Text>
              </TouchableOpacity>

              {weekExpanded && planDays.length > 0 ? (
                <View style={styles.weekExpanded}>
                  {planDays.map((d: any, idx: number) => {
                    const isDone = completedDayNames.has(d.day);
                    return (
                      <View
                        key={`${d.day}-${idx}`}
                        style={[
                          styles.weekDay,
                          idx === planDays.length - 1 && { borderBottomWidth: 0 },
                        ]}
                      >
                        <View style={styles.weekDayHeader}>
                          <Text style={[styles.weekDayName, isDone && { color: colors.accentTeal }]}>
                            {d.day}
                          </Text>
                          <View style={styles.weekDayBadges}>
                            <View style={[styles.weekDayPill, isDone && { borderColor: colors.accentTeal }]}>
                              <Text style={[styles.weekDayPillText, isDone && { color: colors.accentTeal }]}>
                                {d.workoutType}
                              </Text>
                            </View>
                            <View style={styles.weekDayPill}>
                              <Text style={styles.weekDayPillText}>
                                {String(d.location || '').toUpperCase()}
                              </Text>
                            </View>
                            {isDone ? (
                              <Text style={{ color: colors.accentTeal, fontSize: 14, marginLeft: 4 }}>✓</Text>
                            ) : null}
                          </View>
                        </View>
                        {Array.isArray(d.exercises) && d.exercises.length > 0 ? (
                          <View style={styles.weekDayExercises}>
                            {d.exercises.map((ex: any, i: number) => (
                              <Text
                                key={`${ex.name}-${i}`}
                                style={styles.weekDayExerciseText}
                                numberOfLines={1}
                              >
                                {ex.name} · {ex.sets}×{ex.reps}
                              </Text>
                            ))}
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
          )}

          {/* 7-DAY STRIP */}
          {loading ? (
            <View style={styles.weekStripSkeleton}>
              <Skeleton width="100%" height={50} colors={colors} />
            </View>
          ) : (
            <TouchableOpacity
              style={{ marginBottom: layout.spacing.md }}
              onPress={openMonthModal}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Expand to month view"
            >
              <WeekStrip days={lastSevenDays} />
            </TouchableOpacity>
          )}

          {!loading && profile && (
            <View style={styles.profileSummaryCard}>
              <View style={styles.profileSummaryRow}>
                <View style={styles.profileSummaryItem}>
                  <Text style={styles.profileSummaryLabel}>Goal</Text>
                  <Text style={styles.profileSummaryValue}>
                    {profile.goal?.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') ?? '—'}
                  </Text>
                </View>
                <View style={styles.profileSummaryItem}>
                  <Text style={styles.profileSummaryLabel}>Split</Text>
                  <Text style={styles.profileSummaryValue}>
                    {profile.preferred_split?.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') ?? '—'}
                  </Text>
                </View>
              </View>
              <View style={[styles.profileSummaryRow, { marginTop: 12 }]}>
                <View style={styles.profileSummaryItem}>
                  <Text style={styles.profileSummaryLabel}>Level</Text>
                  <Text style={styles.profileSummaryValue}>{profile.fitness_level ? profile.fitness_level.charAt(0).toUpperCase() + profile.fitness_level.slice(1) : '—'}</Text>
                </View>
                {latestWeight !== null && (
                  <View style={styles.profileSummaryItem}>
                    <Text style={styles.profileSummaryLabel}>Weight</Text>
                    <Text style={styles.profileSummaryValue}>{latestWeight} kg</Text>
                  </View>
                )}
              </View>
            </View>
          )}

        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  screenWrapper: {
    flex: 1,
    backgroundColor: colors.background,
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: layout.spacing.lg,
    paddingBottom: layout.spacing.xxl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: layout.spacing.sm,
    marginBottom: layout.spacing.xl,
  },
  greeting: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    color: colors.textPrimary,
    letterSpacing: typography.letterSpacing.heading,
  },
  signalBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: layout.spacing.md,
  },
  signalBannerAmber: {
    backgroundColor: colors.surface,
    borderColor: colors.accentAmber + '55',
  },
  signalBannerTeal: {
    backgroundColor: colors.surface,
    borderColor: colors.accentTeal + '55',
  },
  signalTitle: {
    fontFamily: typography.family.heading,
    fontSize: 13.5,
    letterSpacing: -0.2,
    marginBottom: 2,
  },
  signalBody: {
    fontFamily: typography.family.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  signalCta: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 10,
    letterSpacing: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: layout.smRadius,
    backgroundColor: colors.surfaceElevated,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  avatarText: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    color: colors.textPrimary,
  },
  // ── Coach card — persistent dashboard surface ─────────────────────────
  // Visual hierarchy: dim surface (one notch above background), thin teal
  // accent border to read as the coach voice without competing with the
  // primary today-feature card immediately below. Padding is tight enough
  // that a 3-line message + footer fits without expansion needed.
  coachCard: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingVertical: layout.spacing.md,
    paddingHorizontal: layout.spacing.md,
    marginBottom: layout.spacing.md,
  },
  coachCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  coachCardKicker: {
    fontFamily: typography.family.body,
    fontSize: 11,
    color: colors.accentTeal,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  // Subtle "new" indicator — 6px teal dot. Small enough to be discovered,
  // not loud enough to demand action; the recap is reflective, not
  // actionable.
  coachCardDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accentTeal,
  },
  coachCardLatest: {
    fontFamily: typography.family.body,
    fontSize: 15,
    lineHeight: 21,
    color: colors.textPrimary,
    letterSpacing: 0.1,
  },
  coachCardFooter: {
    fontFamily: typography.family.body,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 8,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  todayFeature: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.md,
    alignItems: 'flex-start',
  },
  todayFeatureActive: {
    // Subtle teal-tinted gradient surrogate (no gradient lib import).
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.accentTeal + '40',
  },
  todayKicker: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.accentTeal,
    marginBottom: 8,
  },
  todayHeadline: {
    fontFamily: typography.family.heading,
    fontSize: 26,
    letterSpacing: -0.6,
    color: colors.textPrimary,
    lineHeight: 30,
  },
  todayMeta: {
    fontFamily: typography.family.body,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 4,
  },
  // ── Recovery gauge (premium, full-width, sage-tinted) ────────────────
  recoveryCard: {
    // Subtle low-opacity sage tint to set "healing" apart from "lifting".
    backgroundColor: '#131615',
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.md,
  },
  recoveryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  recoveryLeft: {
    width: 124,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  recoveryScore: {
    fontFamily: typography.family.heading,
    fontSize: 52,
    letterSpacing: -1.5,
    lineHeight: 56,
    marginTop: 10,
  },
  recoveryScoreBuilding: {
    fontSize: 30,
    lineHeight: 34,
    letterSpacing: -0.6,
    color: colors.textSecondary,
  },
  recoveryBandLabel: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 12,
    letterSpacing: 1.6,
    marginTop: 4,
  },
  recoveryRight: {
    flex: 1,
    paddingLeft: layout.spacing.lg,
    justifyContent: 'center',
  },
  recoveryKicker: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.textMuted,
    marginBottom: 6,
  },
  recoveryReason: {
    fontFamily: typography.family.body,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textPrimary,
  },
  // ── Calibration unlock progress (locked recovery card) ───────────────
  calibrationTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.cardBorder,
    marginTop: layout.spacing.md,
    overflow: 'hidden',
  },
  calibrationFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accentTeal,
  },
  // ── Early small-win pill ─────────────────────────────────────────────
  // Slim positive reassurance shown during the calibration window. Uses the
  // accentPositive token (the same green as the RIR "Easy" chip) so it reads
  // as an honest, low-key win — not a CTA.
  earlyWinPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingVertical: layout.spacing.sm,
    paddingHorizontal: layout.spacing.md,
    marginBottom: layout.spacing.md,
  },
  earlyWinDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accentPositive,
    marginRight: layout.spacing.sm,
  },
  earlyWinText: {
    flex: 1,
    fontFamily: typography.family.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
  },
  // ── Momentum (Consistency | Strength, merged, internal divider) ───────
  momentumCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.md,
    marginBottom: layout.spacing.md,
  },
  momentumHalf: {
    flex: 1,
    paddingHorizontal: layout.spacing.xs,
  },
  momentumDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: colors.cardBorder,
    marginHorizontal: layout.spacing.md,
  },
  momentumKicker: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 10,
    letterSpacing: 1.6,
    color: colors.textMuted,
    marginBottom: layout.spacing.sm,
  },
  momentumValue: {
    fontFamily: typography.family.heading,
    fontSize: 30,
    letterSpacing: -0.8,
    lineHeight: 34,
  },
  momentumLabel: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  momentumSub: {
    fontFamily: typography.family.body,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted,
    marginTop: 2,
  },
  // ── "Train anyway" link on the no-plan today card ────────────────────
  // Footer-rhythm vertical spacing so the link reads as a secondary out,
  // not a CTA. Left-aligned to follow the rest of the card's typography.
  todayInlineLinkWrap: {
    marginTop: layout.spacing.md,
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  todayInlineLink: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 13,
    letterSpacing: 0.4,
    // Muted on purpose — deliberately less prominent than the headline
    // above. The arrow glyph is the discovery cue; the color is not.
    color: colors.textSecondary,
  },
  // ── "Active recovery" ghost button on the rest-day today card ───────
  // Outlined / ghost style so it reads as a clear, tappable option without
  // overpowering the "take the day" headline. Border + label use
  // accentPositive (emerald) — same token the RIR "Easy" chip uses —
  // signalling "soft training option" rather than a primary CTA.
  recoveryGhostBtn: {
    marginTop: layout.spacing.md,
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: layout.smRadius,
    borderWidth: 1,
    borderColor: colors.accentPositive,
    backgroundColor: 'transparent',
  },
  recoveryGhostBtnText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 13,
    letterSpacing: 0.6,
    color: colors.accentPositive,
  },
  weekRow: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: layout.spacing.md,
    overflow: 'hidden',
  },
  weekRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  weekRowLabel: {
    fontFamily: typography.family.heading,
    fontSize: 13.5,
    letterSpacing: -0.2,
    color: colors.textPrimary,
  },
  weekRowMeta: {
    fontFamily: typography.family.body,
    fontSize: 11.5,
    color: colors.textSecondary,
    marginTop: 2,
  },
  weekRowChevron: {
    fontFamily: typography.family.heading,
    fontSize: 22,
    lineHeight: 22,
    color: colors.textMuted,
  },
  weekExpanded: {
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingHorizontal: 16,
    paddingTop: layout.spacing.sm,
    paddingBottom: layout.spacing.xs,
  },
  weekDay: {
    paddingVertical: layout.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  weekDayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  weekDayName: {
    fontFamily: typography.family.heading,
    fontSize: 14,
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  weekDayBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  weekDayPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: layout.pillRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  weekDayPillText: {
    fontFamily: typography.family.body,
    fontSize: 9.5,
    letterSpacing: 1.2,
    color: colors.textSecondary,
    textTransform: 'uppercase',
  },
  weekDayExercises: {
    marginTop: 2,
    gap: 2,
  },
  weekDayExerciseText: {
    fontFamily: typography.family.body,
    fontSize: 11.5,
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  // Loading-state placeholder for the 7-day strip. Mirrors the loaded
  // container at the call site so layout doesn't jump.
  weekStripSkeleton: {
    marginBottom: layout.spacing.md,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: colors.sliderTrack,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 6,
    backgroundColor: colors.accentTeal,
    borderRadius: 3,
  },
  todaySubtext: {
    fontFamily: typography.family.body,
    fontSize: typography.size.md,
    color: colors.textSecondary,
    lineHeight: 22,
  },
  restDayContainer: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: layout.cardRadius,
    padding: layout.spacing.lg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'flex-start',
  },
  restDayText: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    color: colors.textPrimary,
  },
  restDaySubtext: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textSecondary,
    marginTop: layout.spacing.xs,
  },
  workoutName: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    color: colors.textPrimary,
  },
  workoutDuration: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textSecondary,
    marginTop: layout.spacing.xs,
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.md,
  },
  dotCol: {
    alignItems: 'center',
    gap: 6,
  },
  dotFilled: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accentTeal,
  },
  dotMissed: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  dotRest: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.sliderTrack,
  },
  dotLabel: {
    fontFamily: typography.family.body,
    fontSize: typography.size.xs,
    color: colors.textMuted,
  },
  profileSummaryCard: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.md,
    alignItems: 'flex-start',
  },
  profileSummaryRow: {
    flexDirection: 'row',
    gap: layout.spacing.lg,
  },
  profileSummaryItem: {
    flex: 1,
  },
  profileSummaryLabel: {
    fontFamily: typography.family.body,
    fontSize: typography.size.xs,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginBottom: layout.spacing.xs,
  },
  profileSummaryValue: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    color: colors.textPrimary,
  },
  insightCard: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderLeftWidth: 3,
    borderLeftColor: colors.accentTeal,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.md,
  },
  historyRow: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.sm,
  },
  activityRow: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.sm,
  },

  // ── Gap acknowledgment modal ────────────────────
  gapModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: layout.spacing.lg,
  },
  gapModalCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: layout.spacing.xl,
  },
  gapModalEyebrow: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.accentTeal,
    marginBottom: layout.spacing.sm,
  },
  gapModalTitle: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    color: colors.textPrimary,
    lineHeight: 28,
    letterSpacing: -0.4,
    marginBottom: layout.spacing.sm,
  },
  gapModalBody: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textSecondary,
    lineHeight: 21,
  },
  // ── Month calendar modal ───────────────────────────────────────────
  monthHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: layout.spacing.md,
  },
  monthHeaderLabel: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    color: colors.textPrimary,
    letterSpacing: 0.5,
  },
  monthNavBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  monthNavBtnDisabled: {
    opacity: 0.3,
  },
  monthNavGlyph: {
    fontFamily: typography.family.heading,
    fontSize: 20,
    color: colors.textSecondary,
    lineHeight: 22,
  },
  monthDowRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: layout.spacing.sm,
    paddingHorizontal: 2,
  },
  monthDowLabel: {
    flex: 1,
    textAlign: 'center',
    fontFamily: typography.family.body,
    fontSize: 10,
    letterSpacing: 0.8,
    color: colors.textMuted,
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  monthLoadingText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: layout.spacing.xl,
    width: '100%',
  },
  monthCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  monthCellSelected: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: layout.smRadius,
  },
  monthCellNumber: {
    fontFamily: typography.family.body,
    fontSize: 11,
    color: colors.textSecondary,
  },
  monthCellNumberOut: {
    color: colors.textMuted,
    opacity: 0.4,
  },
  monthCellNumberToday: {
    color: colors.accentTeal,
    fontFamily: typography.family.bodyMedium,
  },
  // Dot styling mirrors WeekStrip's vocabulary (18px filled, ring, small rest).
  monthDotCompleted: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.accentTeal,
  },
  monthDotRing: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line ?? colors.border,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthDotMissedGlyph: {
    fontSize: 10,
    lineHeight: 10,
    color: colors.textMuted,
    marginTop: -2,
  },
  monthDotRest: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textMuted,
  },
  monthDaySummary: {
    marginTop: layout.spacing.lg,
    paddingTop: layout.spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  // ── Forward 30-day list rows ───────────────────────────────────────
  forwardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  forwardRowSelected: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: layout.smRadius,
  },
  forwardDateCol: {
    width: 64,
  },
  forwardWeekday: {
    fontFamily: typography.family.bodyMedium,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.textMuted,
  },
  forwardDateNum: {
    fontFamily: typography.family.heading,
    fontSize: 14,
    color: colors.textPrimary,
    marginTop: 2,
  },
  forwardTodayText: {
    color: colors.accentTeal,
  },
  forwardDotWrap: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forwardWorkoutLabel: {
    flex: 1,
    fontFamily: typography.family.body,
    fontSize: 14,
    color: colors.textSecondary,
    marginLeft: 8,
  },
});