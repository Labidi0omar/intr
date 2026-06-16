import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View
} from 'react-native';
import * as Haptics from 'expo-haptics';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { SafeAreaView } from 'react-native-safe-area-context';
import Button from '../src/components/Button';
import { EXERCISES } from '../src/constants/exercises';
import { useTheme } from '../src/context/ThemeContext';
import { supabase } from '../src/lib/supabase';
import { layout, typography } from '../src/theme';
import ShareCard from '../src/components/ShareCard';
import { track, getCompletedWorkoutCount } from '../src/lib/analytics';
import { applyEnergyEffect, buildReadinessNarration, coachLineForPrescription, formatLowEnergyBanner, pickBanner, pickCoachHint, type BannerKind } from '../src/lib/coachHints';
import { buildCampaignStatus } from '../src/lib/campaignStatus';
import { buildCoachRecapContext, produceRecapMessage, requestCoachRecap } from '../src/lib/coachRecap';
import { appendCoachMessage, appendCoachMessageOnce } from '../src/lib/coachMessages';
import { buildSessionPr, type Observation } from '../src/lib/coachObservations';
import { phraseObservation, dedupKeyFor } from '../src/lib/coachVoice';
import { runCoachVoiceUpgrade } from '../src/lib/coachVoiceAI';
import { updateCoachMessageTextByFactSig } from '../src/lib/coachMessages';
import { enqueuePendingSave, runFinishPersistence, type PendingSave } from '../src/lib/pendingSync';
import { computeSessionPrs } from '../src/lib/prDetection';
import { reportSilent } from '../src/lib/errorReporting';
import { prescribeLoad, wasFollowed, hitTargetZone, type Prescription } from '../src/lib/loadPrescription';
import { generateAdHocDay, isCompoundName, CURRENT_PLAN_VERSION, type AdHocWorkoutType } from '../src/lib/planGeneration';
import { ensureCurrentWeekPlan } from '../src/lib/planSync';
import { applySwapToRows, extractPlanDays } from '../src/lib/planSwap';
import { scheduleComebackNotification } from '../src/utils/notifications';
import { normalizeMuscle } from '../src/utils/muscleGroups';

// ── Pure helpers (module-scoped so they aren't recreated per render) ──

/**
 * Local-date YYYY-MM-DD for "today". Called at ACTION time (workout finish,
 * DB read/write) so we never write yesterday's date because the app was left
 * open past midnight. Display-only sites can keep a memoized render-time copy.
 */
function getTodayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD for (today - n days), local. */
function isoDaysAgo(daysAgo: number): string {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Compact "how long ago" formatter for the exercise-view last-used line.
 * Local-midnight math so a same-day reference reads "today" regardless of
 * timezone drift. Returns null when the input is missing or malformed —
 * the caller renders nothing in that case (no dangling "·" separator).
 *
 *   same day → 'today'
 *   1 day    → '1d ago'
 *   < 30d    → 'Nd ago'
 *   < 60d    → '1mo ago'
 *   else     → `${months}mo ago`
 */
function formatLastUsedAgo(yyyymmdd: string | undefined | null): string | null {
  if (!yyyymmdd) return null;
  const parts = yyyymmdd.split('-').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return null;
  const then = new Date(parts[0], parts[1] - 1, parts[2]);
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((todayMid.getTime() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  if (days < 60) return '1mo ago';
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * PR comparison window. "New best in the last 8 weeks" is the honest signal:
 * after a deload, a hard build cycle still earns a PR within a couple weeks.
 * An all-time max from years ago doesn't gate progress forever.
 */
const PR_WINDOW_DAYS = 56;

/**
 * Same-muscle alternatives first; if there are fewer than 3, broaden to the
 * same top-level group so the user is never stuck on "No alternatives found".
 */
function findSwapAlternatives(
  target: { name: string; primaryMuscle: string },
  sessionLocation: string,
  sessionExerciseNames: ReadonlyArray<string> = [],
): typeof EXERCISES {
  // Exclude anything the user is already doing today (case-insensitive).
  // Without this, the swap menu can offer an exercise that's already in
  // the session, which is never the user's intent.
  const excluded = new Set(sessionExerciseNames.map(n => n.toLowerCase()));
  // The target itself is always excluded (you can't swap an exercise for itself).
  excluded.add(target.name.toLowerCase());

  const sameMuscle = EXERCISES.filter(e =>
    e.primaryMuscle.toLowerCase() === target.primaryMuscle.toLowerCase() &&
    e.location.includes(sessionLocation) &&
    !excluded.has(e.name.toLowerCase())
  );
  if (sameMuscle.length >= 3) return sameMuscle;

  const targetGroup = normalizeMuscle(target.primaryMuscle);
  if (!targetGroup) return sameMuscle;

  const seen = new Set(sameMuscle.map(e => e.id));
  const broaderMatches = EXERCISES.filter(e =>
    !seen.has(e.id) &&
    !excluded.has(e.name.toLowerCase()) &&
    e.location.includes(sessionLocation) &&
    normalizeMuscle(e.primaryMuscle) === targetGroup
  );
  return [...sameMuscle, ...broaderMatches];
}

type Phase = 'pre' | 'active' | 'complete';

type Exercise = {
  name: string;
  sets: number;
  reps: string | number;
  restSeconds: number;
  primaryMuscle: string;
  equipment?: string;
  imageUrl?: string;
};

type PlanDay = {
  day: string;
  location: string;
  workoutType: string;
  muscleGroups: string[];
  exercises: Exercise[];
  /** Set on the 4th week of every mesocycle block (PR1's block model). Read
   *  by the coach-recap context builder so the model and the deterministic
   *  fallback both know not to celebrate "progression" on a deload session. */
  deload?: boolean;
};

const getWorkoutStorageKey = (dateStr: string) => `intr_workout_${dateStr}`;

const FEELING_WORDS: Record<number, string> = {
  1: 'DRAINED',
  2: 'LOW',
  3: 'SOLID',
  4: 'SHARP',
  5: 'LOCKED IN',
};

const formatRest = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export default function WorkoutScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();
  const params = useLocalSearchParams<{ energy_score?: string; intent_tag?: string; reflection?: string }>();

  const [loadingInitial, setLoadingInitial] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [planDay, setPlanDay] = useState<PlanDay | null>(null);
  const [muscleGroup, setMuscleGroup] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('pre');
  const [energyScore, setEnergyScore] = useState<number>(3);

  const microLine = useMemo(() => {
    const paramScore = params.energy_score ? parseInt(params.energy_score, 10) : null;
    const energy = paramScore && paramScore >= 1 && paramScore <= 5 ? paramScore : energyScore;
    const intent = params.intent_tag as string | undefined;
    if (energy <= 2) {
      if (intent === 'push_through') return "Low energy noted. Keep the weight, drop a set if you need to.";
      if (intent === 'go_easy') return "Low energy. Light session. That's the right call.";
      if (intent === 'full_send') return "Low energy, full send flagged. Watch your form.";
      return "Low energy noted. Keep the weight, drop a set if you need to.";
    }
    if (energy === 3) return "Solid baseline. Execute the plan.";
    if (energy >= 4) {
      if (intent === 'push_through') return "Sharp today. Don't leave sets on the floor.";
      if (intent === 'go_easy') return "High energy, easy session. Use the surplus tomorrow.";
      if (intent === 'full_send') return "Peak window. Controlled aggression.";
      return "Sharp today. Don't leave sets on the floor.";
    }
    return "Check in complete. Start working.";
  }, [params.energy_score, params.intent_tag, energyScore]);

  const [workout, setWorkout] = useState<Exercise[]>([]);
  const [exIndex, setExIndex] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);

  const [weightLog, setWeightLog] = useState<Record<string, string>>({});
  // Synchronous mirror of weightLog — the COMMIT source of truth. Same
  // contract as rirLogRef below: on the last exercise the weight commit and
  // finishWorkout land in the same tick, so the state snapshot finishWorkout
  // closes over does NOT yet contain the final weight. Everything that
  // persists or detects (logRows, PR detection, recap context) must read
  // this ref; weightLog state exists for rendering. All writes go through
  // commitWeight so the two can't diverge.
  const weightLogRef = useRef<Record<string, string>>({});
  // Parallel to weightLog: exercise name -> reps-in-reserve (0..5). Drives the
  // next-session load prescription. Optional per exercise — null is fine.
  const [rirLog, setRirLog] = useState<Record<string, number>>({});
  // Synchronous mirror of rirLog. The new RIR-as-commit flow lets a single
  // chip tap log the set AND advance to the next exercise. That means the
  // RIR write and the finishWorkout read can land in the same tick on the
  // last exercise — the state update wouldn't have flushed yet. The ref is
  // written synchronously so finishWorkout sees the freshest value.
  const rirLogRef = useRef<Record<string, number>>({});
  // Snapshot of the prescription as it was shown to the user. Lets
  // finishWorkout compare suggested vs. actually-logged without recomputing
  // (which would race against changing energyScore / lastWeights mid-session).
  // Keyed by exercise name. Absence = no suggestion was shown for that exercise.
  type ShownRx = {
    suggested_weight_kg: number;
    delta_pct: number;
    rationale: Prescription['rationale'];
    energy_score: number;
  };
  const [shownPrescriptions, setShownPrescriptions] = useState<Record<string, ShownRx>>({});
  const [lastWeights, setLastWeights] = useState<Record<string, { weight: number; date: string; rir: number | null }>>({});
  // Full per-exercise history (last 6 entries DESC) for coach-hint trend logic.
  // RIR is included on each entry so the coach-recap context builder can
  // surface a per-lift trend with RIR for the model — the data is already in
  // the query, this just keeps it through state instead of dropping it.
  const [exerciseHistory, setExerciseHistory] = useState<Record<string, { weight_kg: number; date: string; rir: number | null }[]>>({});
  const [daysSinceSignup, setDaysSinceSignup] = useState<number>(0);
  // Position within the user's current mesocycle (1–4). Computed in
  // fetchTodayPlan from the earliest weekly_plans row (anchor) and the
  // current plan's week_start. Undefined until loaded; coach-line builder
  // treats undefined as "no week-N nudge", which matches the desired
  // behavior on weeks 1–2 anyway.
  const [blockWeek, setBlockWeek] = useState<number | undefined>(undefined);
  // week_start (YYYY-MM-DD) of the plan row today's session came from.
  // Anchors the campaign-status deload countdown; undefined until loaded
  // and the builder degrades to a week-granularity countdown without it.
  const [planWeekStart, setPlanWeekStart] = useState<string | undefined>(undefined);
  // The coach recap used to render in a Modal here on the completion screen.
  // It now appends to a persistent dashboard coach card (loaded on home
  // focus from src/lib/coachMessages.ts), so the completion screen keeps
  // only its celebratory beat — the recap appears the next time the user
  // opens home. The Modal markup further down is preserved (style-only) for
  // future actionable nudges; popups are reserved for rare, in-the-moment
  // actionable messages, the dashboard card for reflective ones.
  // Set on the complete screen when the workout_sessions / exercise_logs
  // writes fail after a retry and we fall back to the pendingWorkoutSave
  // queue. The UI shows an honest "saved locally, will retry" note so the
  // user knows their session is preserved and will sync on next focus.
  const [syncFailed, setSyncFailed] = useState(false);
  // Fitness level powers the beginner step-halving inside prescribeLoad so
  // the client's pre-fill matches what the server-side replanner computes.
  const [fitnessLevel, setFitnessLevel] = useState<'beginner' | 'intermediate' | 'advanced' | undefined>(undefined);
  // When user taps ⇄ on a pre-screen exercise row, this tracks which one.
  const [swapTargetIndex, setSwapTargetIndex] = useState<number | null>(null);
  const [addExerciseModalVisible, setAddExerciseModalVisible] = useState(false);
  const [addExerciseOptions, setAddExerciseOptions] = useState<typeof EXERCISES>([]);
  const [currentWeightInput, setCurrentWeightInput] = useState('');
  const [weightPhaseForEx, setWeightPhaseForEx] = useState<number | null>(null);
  const [restLeft, setRestLeft] = useState<number | null>(null);
  const restInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track exercise-image URLs that failed to load so we can render a
  // neutral placeholder instead of leaving a blank/stale frame. Catalog
  // imageUrl values come from a remote DB; a 404 (or a transient network
  // hiccup) shouldn't show as a void in the active workout card.
  const [brokenImageUrls, setBrokenImageUrls] = useState<Set<string>>(() => new Set());
  const markImageBroken = (url: string) => {
    setBrokenImageUrls(prev => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  };

  const clearRest = () => {
    if (restInterval.current) { clearInterval(restInterval.current); restInterval.current = null; }
  };
  const startRest = (seconds: number) => {
    clearRest();
    const total = Math.max(0, Math.round(seconds || 0));
    if (total === 0) { setRestLeft(null); return; }
    setRestLeft(total);
    restInterval.current = setInterval(() => {
      setRestLeft(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearRest();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };
  const addRestTime = (delta: number) => {
    setRestLeft(prev => (prev === null ? prev : Math.max(1, prev + delta)));
  };
  const skipRest = () => { clearRest(); setRestLeft(null); };

  const [swapModalVisible, setSwapModalVisible] = useState(false);
  const [swapAlternatives, setSwapAlternatives] = useState<typeof EXERCISES>([]);

  // Energy reduction computed once per (planDay, energyScore) — used by
  // both the pre-screen render and handleStartWorkout so they can't diverge.
  // Declared AFTER state hooks above so the dependency array can safely
  // close over `exerciseHistory` without hitting TDZ.
  const preScreenReduction = useMemo(
    () => applyEnergyEffect(planDay?.exercises ?? [], energyScore),
    [planDay, energyScore]
  );

  // Per-exercise next-session load prescription, keyed by exercise name.
  // Built from lastWeights (carries last RIR) + today's energyScore. The
  // arithmetic is in src/lib/loadPrescription.ts so it's unit-tested.
  const prescriptions = useMemo(() => {
    const out: Record<string, Prescription> = {};
    for (const ex of preScreenReduction.exercises) {
      const last = lastWeights[ex.name];
      if (!last || !last.weight) continue;
      out[ex.name] = prescribeLoad({
        lastWeightKg: last.weight,
        lastRir: last.rir,
        energyScore,
        isCompound: isCompoundName(ex.name),
        fitnessLevel,
      });
    }
    return out;
  }, [preScreenReduction.exercises, lastWeights, energyScore, fitnessLevel]);

  // Per-exercise coach hints memoized so we don't re-hash N names every render.
  // Every state (no_history, hold, progress, backoff, low-energy pulldown,
  // and weeks 3–4 of a block) is handled by coachLineForPrescription so
  // the coach always says something specific — no generic fall-through.
  // Bodyweight exercises bypass the prescription path entirely (no weight to
  // suggest) and use the form-cue picker instead.
  const coachHints = useMemo(() => {
    const out: Record<string, string> = {};
    for (const ex of preScreenReduction.exercises) {
      if ((ex.equipment ?? '').toLowerCase() === 'bodyweight') {
        out[ex.name] = pickCoachHint(
          { name: ex.name, equipment: ex.equipment, primaryMuscle: ex.primaryMuscle },
          exerciseHistory
        );
        continue;
      }
      out[ex.name] = coachLineForPrescription(prescriptions[ex.name], {
        exerciseName: ex.name,
        lastWeightKg: lastWeights[ex.name]?.weight,
        energyScore,
        blockWeek,
      });
    }
    return out;
  }, [preScreenReduction.exercises, exerciseHistory, prescriptions, lastWeights, energyScore, blockWeek]);
  const [newPRs, setNewPRs] = useState<string[]>([]);
  // Committed weight per logged exercise, snapshotted from the logRows the
  // durable save persisted. The completion PR card reads THIS — not
  // weightLog — so the celebrated number is exactly what hit exercise_logs
  // (weightLog state can lag the final commit; see weightLogRef).
  const [prWeights, setPrWeights] = useState<Record<string, number>>({});
  const [showShareCard, setShowShareCard] = useState(false);


  // Render-time only — safe for display props (banner, ShareCard date).
  // Action-time sites (DB reads/writes, AsyncStorage keys) MUST call
  // getTodayStr() fresh — see fetchTodayPlan and finishWorkout.
  const todayStr = getTodayStr();

  const logoScale = useRef(new Animated.Value(0.5)).current;
  const logoGlow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    fetchTodayPlan();
  }, []);

  // Clean up the rest-timer interval if the screen unmounts mid-rest.
  useEffect(() => () => clearRest(), []);

  const fetchTodayPlan = async () => {
    setLoadingInitial(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setErrorMsg('No user session.'); return; }

      // Self-heal: if the latest plan's 7-day window has elapsed (or no plan
      // exists), regenerate anchored on today. Idempotent and tolerant of
      // legacy Monday-anchored rows that still cover today.
      try { await ensureCurrentWeekPlan(); } catch (e) { reportSilent(e, 'workout:ensureCurrentWeekPlan'); }

      // Fresh "today" — the render-time outer copy could be stale if the user
      // left the app open past midnight before pulling-to-refresh.
      const todayStr = getTodayStr();

      const { data: planDoc } = await supabase
        .from('weekly_plans')
        .select('*')
        .eq('user_id', user.id)
        .lte('week_start', todayStr)
        .order('week_start', { ascending: false })
        .limit(1)
        .single();

      let isValidPlan = false;
      if (planDoc) {
        const wsParts = planDoc.week_start.split('-').map(Number);
        const wsPlus6Date = new Date(wsParts[0], wsParts[1] - 1, wsParts[2] + 6);
        const wsPlus6Str = `${wsPlus6Date.getFullYear()}-${String(wsPlus6Date.getMonth() + 1).padStart(2, '0')}-${String(wsPlus6Date.getDate()).padStart(2, '0')}`;
        if (todayStr >= planDoc.week_start && todayStr <= wsPlus6Str) isValidPlan = true;
      }

      if (!isValidPlan) { setErrorMsg('No workout planned for today — go to Plan to set up your week'); return; }

      const daysArr: PlanDay[] = planDoc.plan;
      const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      const todayPlan = daysArr.find(d => d.day === todayName);

      if (!todayPlan) { setErrorMsg('Rest day — enjoy your recovery'); return; }
      if (!todayPlan.exercises || todayPlan.exercises.length === 0) { setErrorMsg("No exercises found in today's plan."); return; }

      setPlanDay(todayPlan);
      setMuscleGroup(todayPlan.workoutType);
      setPlanWeekStart(planDoc.week_start);

      // Mesocycle position: blockWeek ∈ {1,2,3,4} relative to the user's
      // earliest plan row (the same anchor ensureCurrentWeekPlan uses to
      // compute blockIndex). On weeks 3–4 the coach-line builder appends
      // a "chase one more rep" nudge. Best-effort: a query failure leaves
      // blockWeek undefined and the nudge silently doesn't fire.
      try {
        const { data: anchorRow } = await supabase
          .from('weekly_plans')
          .select('week_start')
          .eq('user_id', user.id)
          .order('week_start', { ascending: true })
          .limit(1)
          .maybeSingle();
        const anchor: string | undefined = anchorRow?.week_start;
        if (anchor) {
          const pa = anchor.split('-').map(Number);
          const pw = planDoc.week_start.split('-').map(Number);
          const da = new Date(pa[0], pa[1] - 1, pa[2]);
          const dw = new Date(pw[0], pw[1] - 1, pw[2]);
          const weeks = Math.max(0, Math.round((dw.getTime() - da.getTime()) / 86400000 / 7));
          setBlockWeek((weeks % 4) + 1);
        }
      } catch (e) {
        // Tolerable — blockWeek stays undefined, coach line just skips the nudge.
        reportSilent(e, 'workout:fetchBlockWeek');
      }

      // Days since signup → drives the "first week" banner.
      try {
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('created_at, fitness_level')
          .eq('id', user.id)
          .maybeSingle();
        if (profileRow?.created_at) {
          const created = new Date(profileRow.created_at).getTime();
          const days = Math.max(0, Math.floor((Date.now() - created) / 86400000));
          setDaysSinceSignup(days);
        }
        if (profileRow?.fitness_level) {
          setFitnessLevel(profileRow.fitness_level as 'beginner' | 'intermediate' | 'advanced');
        }
      } catch (e) {
        // Non-fatal — banner will default to no first-week treatment.
        reportSilent(e, 'workout:fetchProfileMeta');
      }

      // Pre-load per-exercise history so coach hints can render immediately
      // on the pre-screen (not delayed until the user taps Start).
      try {
        const exerciseNames = todayPlan.exercises.map(e => e.name);
        const { data: logs } = await supabase
          .from('exercise_logs')
          .select('exercise_name, weight_kg, logged_date, reps_in_reserve')
          .eq('user_id', user.id)
          // EXCLUSION BOUNDARY: load coach must never see recovery weights
          // as "your last set". Drives lastWeights + exerciseHistory.
          .eq('is_recovery', false)
          .in('exercise_name', exerciseNames)
          .order('logged_date', { ascending: false });

        if (logs) {
          const latest: Record<string, { weight: number; date: string; rir: number | null }> = {};
          const grouped: Record<string, { weight_kg: number; date: string; rir: number | null }[]> = {};
          for (const row of logs as any[]) {
            if (!(row.exercise_name in latest)) {
              latest[row.exercise_name] = {
                weight: row.weight_kg,
                date: row.logged_date,
                rir: row.reps_in_reserve ?? null,
              };
            }
            if (!grouped[row.exercise_name]) grouped[row.exercise_name] = [];
            if (grouped[row.exercise_name].length < 6) {
              grouped[row.exercise_name].push({
                weight_kg: row.weight_kg,
                date: row.logged_date,
                rir: row.reps_in_reserve ?? null,
              });
            }
          }
          setLastWeights(latest);
          setExerciseHistory(grouped);
        }
      } catch (e) {
        // Non-fatal — hints will fall back to first-time copy.
        reportSilent(e, 'workout:fetchExerciseHistory');
      }

      // Energy pre-fill: route param wins; otherwise default (energyScore state
      // initializes to the neutral value). Rest-day energy isn't captured
      // anywhere today.
      const paramScore = params.energy_score ? parseInt(params.energy_score, 10) : null;
      if (paramScore && paramScore >= 1 && paramScore <= 5) {
        setEnergyScore(paramScore);
      }

    } catch (e: any) {
      setErrorMsg('No workout planned for today — go to Plan to set up your week');
    } finally {
      setLoadingInitial(false);
    }
  };

  // ── Swap persistence ────────────────────────────────────────────
  // When the user swaps an exercise (pre-screen or mid-session), persist it
  // into every materialized weekly_plans row from today forward that has a
  // day of the SAME workoutType (e.g. all upcoming "Legs" days). This makes
  // the swap stick for the rest of the current mesocycle block; the next
  // block's rows are generated fresh by generatePlan, so the swap naturally
  // expires at the block boundary.
  //
  // Fire-and-forget and fully error-tolerant — a failed plan write must
  // never break the workout. The in-session state update (planDay / workout)
  // is the user-visible source of truth; this is the durable echo.
  const persistSwapToPlan = async (
    workoutType: string | undefined,
    swapOutName: string,
    selected: typeof EXERCISES[0],
  ) => {
    try {
      if (!workoutType) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const todayStr = getTodayStr();
      // Include the row covering today: its week_start can be up to 6 days
      // before today (mid-week anchor), so survey from today-6 forward.
      const tp = todayStr.split('-').map(Number);
      const cutoffDate = new Date(tp[0], tp[1] - 1, tp[2] - 6);
      const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

      const { data: rows, error } = await supabase
        .from('weekly_plans')
        .select('week_start, plan')
        .eq('user_id', user.id)
        .gte('week_start', cutoff)
        .order('week_start', { ascending: true });
      if (error || !rows) return;

      const planRows = rows.map((r: any) => ({
        weekStart: r.week_start as string,
        days: extractPlanDays(r.plan),
      }));

      const { changedRows } = applySwapToRows({
        rows: planRows,
        todayIso: todayStr,
        workoutType,
        swapOutName,
        replacementEntry: selected,
      });
      if (changedRows.length === 0) return;

      for (const cr of changedRows) {
        const { error: upsertError } = await supabase.from('weekly_plans').upsert(
          // Re-stamp the current version so the row stays "satisfied" and
          // ensureCurrentWeekPlan's version gate never regenerates over it.
          { user_id: user.id, week_start: cr.weekStart, plan: cr.days, plan_version: CURRENT_PLAN_VERSION },
          { onConflict: 'user_id,week_start' },
        );
        if (upsertError) reportSilent(upsertError, 'workout:persistSwap:upsert');
      }

      // Keep the plan:current cache in sync so the dashboard (which also
      // reads weekly_plans directly) and any cache consumer reflect the swap
      // immediately. Find the changed row whose 7-day window contains today.
      const coveringChanged = changedRows.find(cr => {
        const cp = cr.weekStart.split('-').map(Number);
        const endDate = new Date(cp[0], cp[1] - 1, cp[2] + 6);
        const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
        return cr.weekStart <= todayStr && todayStr <= endStr;
      });
      if (coveringChanged) {
        try {
          const rawCache = await AsyncStorage.getItem('plan:current');
          if (rawCache) {
            const parsed = JSON.parse(rawCache);
            if (parsed?.weekStart === coveringChanged.weekStart) {
              parsed.days = coveringChanged.days;
              await AsyncStorage.setItem('plan:current', JSON.stringify(parsed));
            }
          }
        } catch (e) {
          reportSilent(e, 'workout:persistSwap:cache');
        }
      }
    } catch (e) {
      reportSilent(e, 'workout:persistSwap');
    }
  };

  // ── Pre-screen actions ──────────────────────────────────────────
  // The user's source of truth for today's exercise list is `planDay.exercises`
  // until they tap Start. We mutate planDay locally — no DB write.

  const openPreScreenSwap = (idx: number) => {
    if (!planDay) return;
    const target = planDay.exercises[idx];
    setSwapAlternatives(findSwapAlternatives(target, planDay.location ?? 'gym', planDay.exercises.map(e => e.name)));
    setSwapTargetIndex(idx);
    setSwapModalVisible(true);
  };

  const confirmPreScreenSwap = (selected: typeof EXERCISES[0]) => {
    if (!planDay || swapTargetIndex === null) return;
    const swapOutName = planDay.exercises[swapTargetIndex].name;
    const swapped: Exercise = {
      name: selected.name,
      sets: planDay.exercises[swapTargetIndex].sets,
      reps: selected.reps,
      restSeconds: selected.restSeconds,
      primaryMuscle: selected.primaryMuscle,
      equipment: selected.equipment,
      imageUrl: selected.imageUrl,
    };
    const newExercises = [...planDay.exercises];
    newExercises[swapTargetIndex] = swapped;
    setPlanDay({ ...planDay, exercises: newExercises });
    setSwapTargetIndex(null);
    setSwapModalVisible(false);
    // Durable echo: stick this swap across the rest of the block.
    void persistSwapToPlan(planDay.workoutType, swapOutName, selected);
  };

  const openAddExercise = () => {
    if (!planDay) return;
    const presentNames = new Set(planDay.exercises.map(e => e.name.toLowerCase()));
    const todayMuscles = new Set(planDay.exercises.map(e => e.primaryMuscle.toLowerCase()));
    const sessionLocation = planDay.location ?? 'gym';
    const candidates = EXERCISES.filter(e =>
      todayMuscles.has(e.primaryMuscle.toLowerCase()) &&
      e.location.includes(sessionLocation) &&
      !presentNames.has(e.name.toLowerCase())
    );
    setAddExerciseOptions(candidates);
    setAddExerciseModalVisible(true);
  };

  const confirmAddExercise = (selected: typeof EXERCISES[0]) => {
    if (!planDay) return;
    const appended: Exercise = {
      name: selected.name,
      sets: selected.sets,
      reps: selected.reps,
      restSeconds: selected.restSeconds,
      primaryMuscle: selected.primaryMuscle,
      equipment: selected.equipment,
      imageUrl: selected.imageUrl,
    };
    setPlanDay({ ...planDay, exercises: [...planDay.exercises, appended] });
    setAddExerciseModalVisible(false);
  };

  const addSetToTarget = (targetName: string) => {
    if (!planDay) return;
    const newExercises = planDay.exercises.map(e =>
      e.name === targetName ? { ...e, sets: e.sets + 1 } : e
    );
    setPlanDay({ ...planDay, exercises: newExercises });
  };

  const handleStartWorkout = async () => {
    if (!planDay) return;

    // Use the same reduction the pre-screen already showed the user — single
    // source of truth, no chance of divergence.
    const exercises =
      workout.length === 0
        ? JSON.parse(JSON.stringify(preScreenReduction.exercises))
        : workout;
    if (workout.length === 0) setWorkout(exercises);

    setStartTime(Date.now());
    setPhase('active');

    // Analytics — session_index = count of already-completed workouts + 1
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const prior = await getCompletedWorkoutCount(user.id);
        track('workout_started', { session_index: prior + 1, energy_score: energyScore });

        // Persist the readiness narration to the dashboard coach card.
        // appendCoachMessageOnce dedups by `readiness:{yyyy-mm-dd}` so a
        // user who backs out of the active phase and re-taps Start (or who
        // toggles their energy and re-starts the same day) doesn't see
        // two readiness entries. Null narration (energy=3) skips entirely.
        const readiness = buildReadinessNarration(energyScore);
        if (readiness) {
          await appendCoachMessageOnce(
            user.id,
            `readiness:${getTodayStr()}`,
            { text: readiness.text, kind: 'autoreg' },
          );
        }
      }
    } catch (e) {
      // non-fatal
      reportSilent(e, 'workout:trackStart');
    }
  };


  const openSwapModal = () => {
    setSwapAlternatives(findSwapAlternatives(workout[exIndex], planDay?.location ?? 'gym', workout.map(e => e.name)));
    setSwapModalVisible(true);
  };

  const confirmSwap = (selected: typeof EXERCISES[0]) => {
    const swapOutName = workout[exIndex].name;
    const swapped: Exercise = {
      name: selected.name,
      sets: workout[exIndex].sets,
      reps: selected.reps,
      restSeconds: selected.restSeconds,
      primaryMuscle: selected.primaryMuscle,
      equipment: selected.equipment,
      imageUrl: selected.imageUrl,
    };
    const updated = [...workout];
    updated[exIndex] = swapped;
    setWorkout(updated);
    setSwapModalVisible(false);
    // Durable echo: stick this swap across the rest of the block.
    void persistSwapToPlan(planDay?.workoutType, swapOutName, selected);
  };

  const currentEx = workout[exIndex];

  const handleNextExercise = () => {
    setWeightPhaseForEx(exIndex);
    // Pre-fill with the prescription if we have one — that's the coach
    // actually doing the math. Falls back to last logged weight, then empty.
    const exName = workout[exIndex]?.name;
    const rx = exName ? prescriptions[exName] : undefined;
    const last = exName ? lastWeights[exName]?.weight : undefined;
    const seed = rx ? rx.suggestedWeightKg : last;
    setCurrentWeightInput(seed !== undefined ? String(seed) : '');

    // RIR is intentionally NOT seeded here. The legacy behavior pre-selected
    // 'Solid' (RIR=2) so every set logged a value, but the resulting capture
    // was noise — most sets persisted as 2 regardless of how they actually
    // felt, and the autoregulator pulled progression decisions from that
    // false signal. The redesigned weight phase makes RIR the primary commit
    // (one chip tap logs the set with that RIR), so the default-Solid crutch
    // is no longer needed.

    // Measurement: snapshot the shown prescription and fire prescription_shown
    // once per exercise per session. Skip no_history (we didn't actually
    // suggest anything in that case).
    if (exName && rx && rx.rationale !== 'no_history' && !shownPrescriptions[exName]) {
      const snapshot: ShownRx = {
        suggested_weight_kg: rx.suggestedWeightKg,
        delta_pct: rx.deltaPct,
        rationale: rx.rationale,
        energy_score: energyScore,
      };
      setShownPrescriptions(prev => ({ ...prev, [exName]: snapshot }));
      track('prescription_shown', { exercise_name: exName, ...snapshot });
    }
  };

  /** Single write path for a committed weight ('bw' included). Writes the
   *  synchronous ref first — finishWorkout may run in this same tick on the
   *  last exercise and must see the value — then mirrors to state for
   *  rendering. The key is the CURRENT workout[i].name, so a swapped
   *  exercise commits under its new name and every downstream consumer
   *  (logRows, PR detection, recap) keys consistently. */
  const commitWeight = (exName: string, value: string) => {
    const next = { ...weightLogRef.current, [exName]: value };
    weightLogRef.current = next;
    setWeightLog(next);
  };

  const handleWeightLog = () => {
    if (currentWeightInput.trim()) {
      commitWeight(workout[weightPhaseForEx!].name, currentWeightInput.trim());
    }
    setCurrentWeightInput('');
    setWeightPhaseForEx(null);

    if (exIndex < workout.length - 1) {
      const restSecs = workout[exIndex]?.restSeconds ?? 60;
      setExIndex(prev => prev + 1);
      startRest(restSecs);
    } else {
      // Auto-save and go to complete
      finishWorkout();
    }
  };

  /**
   * Primary commit path on the weight phase: a single chip tap records the
   * weight AND the RIR, then advances. Passing rir=null means "log the weight
   * without a rating" — the deliberate skip-RIR action surfaced as a smaller
   * secondary button. Either way the weight is preserved if entered.
   *
   * The RIR write goes to both React state (for the next render of any RIR
   * chips on later exercises) AND a synchronous ref (so finishWorkout, which
   * may be called this same tick on the last exercise, reads the value the
   * user just chose instead of the previous render's snapshot).
   */
  const commitWithRir = (rir: number | null) => {
    const exName = weightPhaseForEx != null ? workout[weightPhaseForEx]?.name : undefined;
    if (exName) {
      if (rir == null) {
        // Deliberate skip: clear any stale value so we don't carry an earlier
        // attempt's RIR into a no-rating log.
        const next = { ...rirLogRef.current };
        delete next[exName];
        rirLogRef.current = next;
        setRirLog(next);
      } else {
        const next = { ...rirLogRef.current, [exName]: rir };
        rirLogRef.current = next;
        setRirLog(next);
      }
    }
    handleWeightLog();
  };

  const skipWeightLog = () => {
    // Skip the SET entirely — neither weight nor RIR is recorded. Also clear
    // any stale RIR for this exercise so a half-finished interaction can't
    // leave a phantom rating behind.
    const exName = weightPhaseForEx != null ? workout[weightPhaseForEx]?.name : undefined;
    if (exName && rirLogRef.current[exName] !== undefined) {
      const next = { ...rirLogRef.current };
      delete next[exName];
      rirLogRef.current = next;
      setRirLog(next);
    }
    setCurrentWeightInput('');
    setWeightPhaseForEx(null);
    if (exIndex < workout.length - 1) {
      const restSecs = workout[exIndex]?.restSeconds ?? 60;
      setExIndex(prev => prev + 1);
      startRest(restSecs);
    } else {
      finishWorkout();
    }
  };

  const finishWorkout = async () => {
    // FIX 3: stop any running rest interval before we transition to 'complete'.
    // Without this, a late tick can call setRestLeft after we've left the
    // active phase, which is harmless but logs spurious React warnings.
    clearRest();

    // Build `save` BEFORE entering the per-phase try blocks so the outer
    // catch (and the user-id guard) can attempt a last-resort enqueue if a
    // throw happens anywhere downstream. Synchronous, in-memory data only.
    let save: PendingSave | null = null;

    try {
      // ── Phase 1: Auth (own guard) ─────────────────────────────────────
      let userId: string | null = null;
      try {
        const { data: { user } } = await supabase.auth.getUser();
        userId = user?.id ?? null;
      } catch (e) {
        reportSilent(e, 'workout:finish:auth');
      }
      if (!userId) { setPhase('complete'); return; }

      // ── Phase 2: Build the save from in-memory state ──────────────────
      // No fetches. The historical bug was that a pre-save network read
      // could throw and abort the outer try BEFORE the save ever ran —
      // here we keep all I/O after this synchronous build step.
      const todayStr = getTodayStr();
      const nowDate = new Date();
      const logDate = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
      const windowStartStr = isoDaysAgo(PR_WINDOW_DAYS);

      // Committed weights — read from the ref, NOT weightLog state. On the
      // last exercise the commit and this call land in the same tick, so the
      // state snapshot in scope is missing the final weight (same hazard
      // rirLogRef exists for). The ref is the per-commit source of truth and
      // includes every exercise, swapped names included.
      const committedWeights = { ...weightLogRef.current };

      const loggedExerciseNames = Object.keys(committedWeights).filter(name => {
        const w = committedWeights[name];
        return w && !isNaN(parseFloat(w));
      });

      const logRows = Object.entries(committedWeights)
        .filter(([, w]) => w && !isNaN(parseFloat(w)))
        .map(([exerciseName, w]) => ({
          user_id: userId!,
          exercise_name: exerciseName,
          weight_kg: parseFloat(w),
          logged_date: logDate,
          session_id: null as string | null,
          // Read from the ref, not state — see commitWithRir for why the
          // ref is the synchronous source of truth on the last-set commit.
          reps_in_reserve: rirLogRef.current[exerciseName] ?? null,
        }));

      save = {
        userId: userId,
        plannedDate: todayStr,
        session: {
          user_id: userId,
          planned_date: todayStr,
          completed_at: new Date().toISOString(),
          workout_type: planDay?.workoutType,
          location: planDay?.location,
          energy_level: energyScore <= 2 ? 'low' : energyScore >= 4 ? 'high' : 'normal',
          // Durable raw energy (1–5) for the Training Status engine. The
          // lossy energy_level bucket above stays for the existing reads.
          energy_score: energyScore,
          completed: true,
          exercises_done: workout,
          replanned: false,
        },
        logRows,
        queuedAt: new Date().toISOString(),
      };

      // ── Phase 3: Durable save FIRST, then best-effort PR fetch ────────
      // runFinishPersistence runs the save before the prior-log read and
      // absorbs any throw from the prior-log read — see the function for
      // the ordering contract. The save is committed (network or
      // pendingWorkoutSave queue) BEFORE PR detection even starts.
      const persistence = await runFinishPersistence(save, {
        fetchPriorLogs: async () => {
          if (loggedExerciseNames.length === 0) return [];
          const { data, error } = await supabase
            .from('exercise_logs').select('exercise_name, weight_kg, logged_date')
            .eq('user_id', userId!)
            // EXCLUSION BOUNDARY: PR detection. A 5kg prehab dumbbell row
            // must never register as a new bench-press PR. See
            // src/lib/recovery.ts.
            .eq('is_recovery', false)
            .in('exercise_name', loggedExerciseNames)
            .gte('logged_date', windowStartStr)
            // STRICTLY BEFORE today: the durable save has already run, so an
            // unbounded fetch returns this session's own rows and every PR
            // comparison fails against itself. computeSessionPrs re-applies
            // this guard on logged_date as a second line of defense.
            .lt('logged_date', logDate);
          if (error) throw error;
          return data ?? [];
        },
      });

      if (!persistence.saveOk) {
        reportSilent(
          persistence.saveError instanceof Error
            ? persistence.saveError
            : new Error('finishWorkout save failed: ' + JSON.stringify(persistence.saveError ?? null)),
          'workout:finish:saveFailed',
          { enqueued: persistence.enqueued },
        );
        setSyncFailed(true);
      }
      if (persistence.priorLogsError) {
        // PR fetch failed but the save is safe. Decoration only — surface
        // to Sentry so we know the network is flaky and move on.
        reportSilent(persistence.priorLogsError, 'workout:finish:priorLogsFetch');
      }
      // Wire the (now-known) session id back into logRows so the downstream
      // prescription_outcome track loop sees the right id. Safe when null
      // (queued path) — the field stays null, matching legacy behavior.
      for (const row of logRows) row.session_id = persistence.sessionId;

      // Clear the in-progress draft regardless of save success — the user
      // hit Finish, conceptually they're done editing. The pendingWorkoutSave
      // queue carries the data forward if the network was the problem.
      try { await AsyncStorage.removeItem(getWorkoutStorageKey(todayStr)); }
      catch (e) { reportSilent(e, 'workout:finish:clearDraft'); }

      // ── Phase 4: prescription_outcome analytics (best-effort) ─────────
      try {
        for (const row of logRows) {
          const rx = shownPrescriptions[row.exercise_name];
          if (!rx) continue;
          const rir = rirLogRef.current[row.exercise_name] ?? null;
          track('prescription_outcome', {
            exercise_name: row.exercise_name,
            suggested_weight_kg: rx.suggested_weight_kg,
            logged_weight_kg: row.weight_kg,
            followed: wasFollowed(rx.suggested_weight_kg, row.weight_kg),
            rir_logged: rir,
            hit_target_zone: hitTargetZone(rir),
            rationale: rx.rationale,
            energy_score: rx.energy_score,
          });
        }
      } catch (e) {
        reportSilent(e, 'workout:finish:prescriptionOutcome');
      }

      // ── Phase 5: PR detection (pure — uses already-fetched logs) ──────
      // PR = "new best within the last 8 weeks". previousLogs is bounded
      // by PR_WINDOW_DAYS so this is a recent best, not an all-time max.
      // Bodyweight 'bw' rows never enter logRows (parseFloat filter), so
      // we never fabricate a bodyweight PR.
      //
      // Comparison reads the COMMITTED weights in logRows — the exact rows
      // the durable save persisted (swapped exercises keyed by their new
      // name) — never weightLog state, which can lag the final commit.
      // computeSessionPrs also drops any prior row dated on/after today, so
      // the session's own just-saved rows can't suppress genuine PRs.
      let prMeta: Array<{ name: string; newWeightKg: number; prevBestKg: number }> = [];
      if (logRows.length > 0) {
        try {
          const result = computeSessionPrs(logRows, persistence.priorLogs, logDate);
          setNewPRs(result.prs);
          setPrWeights(result.prWeights);
          prMeta = result.meta;
        } catch (e) {
          reportSilent(e, 'workout:finish:prDetection');
        }
      }

      // ── Phase 5b: PR coach messages (top 1-2 by absolute jump) ────────
      // Routes through the BRAIN (buildSessionPr → Observation) and the
      // MOUTH (phraseObservation) so the dashboard and finish flow share
      // ONE voice and ONE dedup primitive. Dedup is per-factSig (`pr-${kg}`),
      // not per-day: re-finishing the same session, OR PRing the same kg
      // twice, is a no-op forever.
      try {
        if (prMeta.length > 0) {
          const { data: { user: prUser } } = await supabase.auth.getUser();
          if (prUser) {
            const today = getTodayStr();
            const top = [...prMeta]
              .sort((a, b) => (b.newWeightKg - b.prevBestKg) - (a.newWeightKg - a.prevBestKg))
              .slice(0, 2);
            const appendedObs: Observation[] = [];
            for (const pr of top) {
              const obs = buildSessionPr(pr.name, pr.newWeightKg, pr.prevBestKg, today);
              if (obs) {
                await appendCoachMessageOnce(
                  prUser.id,
                  dedupKeyFor(obs),
                  { text: phraseObservation(obs), kind: 'observation' },
                );
                appendedObs.push(obs);
              }
            }
            // ── AI voice upgrade. No-op when COACH_AI_VOICE is off. Fires
            // in the background; the upgraded line surfaces the next time
            // the dashboard card re-renders (typically when the user
            // navigates back to home).
            void runCoachVoiceUpgrade(prUser.id, appendedObs, updateCoachMessageTextByFactSig);
          }
        }
      } catch (e) {
        reportSilent(e, 'workout:finish:prCoachMessages');
      }

      // ── Phase 6: workout_completed analytics (best-effort) ────────────
      // Only emit on first-completion-per-day so dedupe is honest. On the
      // queued path (saveOk=false) we don't emit; flushPendingSaves syncs
      // data but doesn't backfill analytics.
      if (persistence.saveOk && persistence.wasFresh) {
        try {
          const sessionIndex = await getCompletedWorkoutCount(userId);
          track('workout_completed', {
            session_index: sessionIndex,
            energy_score: energyScore,
            replanned: false,
          });
          // Funnel: activation_reached fires the moment the user
          // crosses session #3 — the threshold where the load engine
          // has enough RIR signal to actually autoregulate (the
          // "engine turns on" point). Promoted to a first-class event
          // so the funnel view doesn't have to derive it from the
          // session_index column of workout_completed.
          if (sessionIndex === 3) {
            track('activation_reached', { session_index: sessionIndex });
          }
        } catch (e) {
          reportSilent(e, 'workout:finish:completedAnalytics');
        }
      }

      // Push the comeback nudge another 3 days out — they just trained,
      // so the absent-for-3-days notification shouldn't fire any sooner.
      void scheduleComebackNotification();
    } catch (e) {
      // Outer last-resort catch. A throw here means we got past auth + save
      // build but something below blew up in a way the per-phase guards
      // didn't catch (genuinely unexpected). Report it, and if the save was
      // built but we don't know whether it was persisted, attempt the queue
      // as last resort so the user's session is never silently dropped.
      reportSilent(e, 'workout:finish:outerCatch');
      if (save) {
        try { await enqueuePendingSave(save); }
        catch (e2) { reportSilent(e2, 'workout:finish:lastResortEnqueue'); }
        setSyncFailed(true);
      }
    }

    // ── Coach recap (best-effort, never blocks) ─────────────────────────
    // Build the context from data already in scope and ask the edge function
    // for a one-to-two-sentence recap. Cache by (user_id, date) so reopening
    // /workout in 'complete' state doesn't re-bill. Any error/timeout leaves
    // recapMessage null and the popup never appears — finish flow continues
    // either way. Wrapped in its own try/catch as a belt-and-braces guard;
    // requestCoachRecap is already non-throwing.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const nowDate = new Date();
        const recapDate = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
        const cacheKey = `coachRecap:${user.id}:${recapDate}`;

        // The day-cache key still gates the AI call so a same-day re-finish
        // doesn't re-bill. When it's already set we've appended the message
        // once today; we don't repeat the append (the dashboard card already
        // has it).
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached) {
          // No-op: today's recap is already on the coach card.
        } else {
          // Compute the per-exercise logs the model + fallback both consume.
          // Bodyweight exercises ('bw') become weight_kg=null so the prose
          // talks reps, not weight. Anything with a parseable number becomes
          // a kg value. Missing entries are dropped. Reads the committed ref,
          // not weightLog state — this still runs inside the same tick as the
          // last exercise's commit on the auto-finish path.
          const todayLogs = workout
            .map(ex => {
              const raw = weightLogRef.current[ex.name];
              if (!raw) return null;
              const isBW = raw === 'bw';
              const n = parseFloat(raw);
              if (!isBW && isNaN(n)) return null;
              return {
                exercise_name: ex.name,
                weight_kg: isBW ? null : n,
                reps: ex.reps ?? null,
                rir: rirLogRef.current[ex.name] ?? null,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);

          // Streak from workout_sessions. Inline so we don't pull streak.ts
          // (which transitively touches supabase) at module top and so this
          // stays best-effort: a fetch failure leaves streak=0 and the
          // context-builder de-emphasizes it.
          let streak = 0;
          try {
            const { data: sessions } = await supabase
              .from('workout_sessions')
              .select('planned_date')
              .eq('user_id', user.id)
              .eq('completed', true)
              .order('planned_date', { ascending: false })
              .limit(60);
            if (sessions && sessions.length > 0) {
              const uniq = new Set(sessions.map((s: any) => s.planned_date as string));
              const todayHas = uniq.has(recapDate);
              for (let i = todayHas ? 0 : 1; ; i++) {
                const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
                const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (uniq.has(ds)) streak++;
                else break;
              }
            }
          } catch (e) {
            reportSilent(e, 'workout:recapStreakFetch');
          }

          // Rich context: today's logs, per-lift trend (last 2-3 sessions),
          // target-zone hit, deload, low-energy-trained, cold-start. Built
          // by a pure helper so the shape is unit-tested independent of
          // React state. Same context feeds both the AI prompt and the
          // deterministic fallback so the salience is consistent either way.
          const ctx = buildCoachRecapContext({
            todayStr: recapDate,
            workoutType: planDay?.workoutType,
            planDayDeload: planDay?.deload,
            todayLogs,
            prs: newPRs,
            energyScore,
            streak,
            blockWeek,
            lastWeights,
            exerciseHistory,
          });

          const result = await requestCoachRecap(ctx);
          // AI is the upgrade layer; on any failure (timeout / missing key /
          // non-200 / empty body) we fall back to the deterministic recap
          // built from the same facts. produceRecapMessage encodes that
          // contract so the integration test can exercise both paths.
          const message = produceRecapMessage(result, ctx);
          // Cache the message so a same-day re-finish doesn't re-bill the
          // AI or re-append to the coach card.
          try { await AsyncStorage.setItem(cacheKey, message); } catch (e) { reportSilent(e, 'workout:recapCacheWrite'); }
          // Append to the persistent coach-message store. The dashboard
          // card reads this on focus; the user sees the recap on next open.
          // appendCoachMessage is non-throwing; reports its own failures.
          await appendCoachMessage(user.id, { text: message, kind: 'recap' });

          // Campaign status — the "Week 3 of the hypertrophy block / bench
          // up 7.5 kg since week 1 / deload in 5 days" framing. Appended
          // AFTER the recap so it lands newest and headlines the dashboard
          // card. Deterministic (no AI), null when blockWeek is unknown,
          // deduped per day so a same-day re-finish doesn't repeat it.
          const campaign = buildCampaignStatus({
            todayStr: recapDate,
            blockWeek,
            weekStart: planWeekStart,
            energyScore,
            todayLogs,
            exerciseHistory,
          });
          if (campaign) {
            await appendCoachMessageOnce(user.id, `campaign:${recapDate}`, {
              text: campaign,
              kind: 'campaign',
            });
          }
        }
      }
    } catch (e) {
      // Belt-and-braces: requestCoachRecap is non-throwing, but if context
      // gathering itself throws we still want the finish flow to proceed.
      reportSilent(e, 'workout:recapWrapper');
    }

    setPhase('complete');
    Animated.parallel([
      Animated.spring(logoScale, { toValue: 1.2, friction: 4, tension: 5, useNativeDriver: true }),
      Animated.timing(logoGlow, { toValue: 1, duration: 1000, useNativeDriver: true })
    ]).start();
  };

  const goHome = () => {
    router.replace('/home');
  };

  /**
   * "Train anyway" entry point used by the rest-day / no-plan error screen.
   * Builds a single PlanDay of the chosen type, snaps it to today, and
   * drops the user into the normal pre-workout flow. From this point on,
   * the session writes (workout_sessions + exercise_logs) and downstream
   * coach lines are identical to a planned session — finishWorkout cannot
   * distinguish ad-hoc from planned, by design.
   *
   * Best-effort: a generation failure (shouldn't happen given AD_HOC_CONFIGS
   * fully maps every AdHocWorkoutType) leaves the user on the error screen
   * with the existing "Back to Home" out, never blocks them.
   */
  const startAdHocSession = async (type: AdHocWorkoutType) => {
    try {
      // Default location reflects the user's saved preference; falls back to
      // gym so equipment-filtered exercise selection still has a deep pool.
      const storedLoc = await AsyncStorage.getItem('user:defaultLocation');
      const location = storedLoc === 'Home' ? 'home' : 'gym';
      const todayStr = getTodayStr();
      const day = generateAdHocDay({
        workoutType: type,
        location,
        fitnessLevel: fitnessLevel ?? 'beginner',
        blockIndex: blockWeek ? Math.floor((blockWeek - 1) / 4) : 0,
        startDate: todayStr,
      });
      if (!day || !day.exercises || day.exercises.length === 0) {
        // Generation produced nothing usable — leave the user on the error
        // screen rather than send them into an empty session.
        reportSilent(new Error(`ad-hoc generator returned empty for ${type}`), 'workout:adHocEmpty', { type });
        return;
      }
      setErrorMsg('');
      setPlanDay(day);
      setMuscleGroup(day.workoutType);
      track('workout_started', { ad_hoc: true, ad_hoc_type: type, energy_score: energyScore });
    } catch (e) {
      reportSilent(e, 'workout:startAdHocSession', { type });
    }
  };

  // ─── WORKOUT PROGRESS METER ────────────────────────────────────────

  const progressPct = workout.length > 0 ? (exIndex + 1) / workout.length : 0;

  // ─── PRE CHECKIN VIEW ──────────────────────────────────────────────

  if (loadingInitial) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background, padding: 24, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ fontFamily: typography.family.heading, color: colors.textSecondary }}>Loading your workout...</Text>
      </SafeAreaView>
    );
  }

  if (errorMsg) {
    // "Train anyway" affordance — every error message that means "no
    // workout today" (rest day, no plan, missing exercises) gets the same
    // single-day picker so the user is never blocked. We deliberately don't
    // show it for hard errors like "No user session" — those require sign-in,
    // not a workout. The heuristic: messages mentioning 'planned' or 'Rest'
    // are recoverable; anything else is a real error and just gets Back-to-Home.
    const showAdHoc =
      errorMsg.includes('planned') ||
      errorMsg.includes('Rest day') ||
      errorMsg.includes("today's plan");
    const adHocChoices: AdHocWorkoutType[] = ['Push', 'Pull', 'Legs', 'Upper', 'Lower', 'Full Body'];

    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: 24,
            paddingTop: 48,
            paddingBottom: 32,
            justifyContent: 'center',
          }}
          showsVerticalScrollIndicator={false}
        >
          {/* Primary message — typographic hierarchy matches the complete
              screen so the empty/rest state feels intentional, not broken. */}
          <Text
            style={{
              fontFamily: typography.family.heading,
              fontSize: 24,
              lineHeight: 30,
              color: colors.textPrimary,
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            {errorMsg.includes('Rest day') ? 'Rest day' : 'No plan for today'}
          </Text>
          <Text
            style={{
              fontFamily: typography.family.body,
              fontSize: 15,
              lineHeight: 22,
              color: colors.textSecondary,
              textAlign: 'center',
              marginBottom: showAdHoc ? 32 : 24,
            }}
          >
            {errorMsg.includes('Rest day')
              ? 'Enjoy your recovery — or train anyway below.'
              : errorMsg.includes('planned')
                ? "Your coach will build a fresh week on Home. You can also start one now."
                : errorMsg}
          </Text>

          {showAdHoc && (
            <View style={{ marginBottom: 32 }}>
              {/* Section label — small caps consistent with other section
                  headers in the app (e.g. PR cards, share-session button). */}
              <Text
                style={{
                  fontFamily: typography.family.body,
                  fontSize: 11,
                  color: colors.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  textAlign: 'center',
                  marginBottom: 12,
                }}
              >
                Train anyway
              </Text>
              {/* 3-column grid of workout types. Each card is a tappable
                  surface with a 1px border, matching the swap-modal option
                  style. Tapping one launches the same pre-workout flow a
                  scheduled session would. */}
              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                {adHocChoices.map(type => (
                  <TouchableOpacity
                    key={type}
                    onPress={() => startAdHocSession(type)}
                    activeOpacity={0.7}
                    style={{
                      width: '31%',
                      paddingVertical: 18,
                      paddingHorizontal: 8,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: colors.cardBorder,
                      backgroundColor: colors.surface,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: typography.family.bodyMedium,
                        fontSize: 14,
                        color: colors.textPrimary,
                        textAlign: 'center',
                      }}
                    >
                      {type}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text
                style={{
                  fontFamily: typography.family.body,
                  fontSize: 11,
                  color: colors.textMuted,
                  textAlign: 'center',
                  marginTop: 12,
                  lineHeight: 16,
                }}
              >
                Logs and recap exactly like a planned session.
              </Text>
            </View>
          )}

          <View style={{ alignItems: 'center' }}>
            <Button title="Back to Home" variant="ghost" onPress={() => router.replace('/home')} />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === 'pre' && planDay) {
    // Energy 1-2 actually reduces volume. The plan in state stays untouched
    // so the user can adjust energy freely and see effects update live.
    // Single source of truth — both the pre-screen render and handleStartWorkout
    // read from preScreenReduction.exercises.
    const banner: BannerKind = pickBanner({
      daysSinceSignup,
      energyScore,
      exercises: preScreenReduction.exercises,
      todayStr,
      reduction: { setsCut: preScreenReduction.setsCut, exerciseDropped: preScreenReduction.exerciseDropped },
      boost: { setsAdded: preScreenReduction.setsAdded, repBump: preScreenReduction.repBump },
    });
    const effectiveExercises = preScreenReduction.exercises;

    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <ScrollView contentContainerStyle={styles.preScroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.preTitle}>Today</Text>
          <Text style={styles.preSubtitle}>{planDay.workoutType.toUpperCase()}</Text>

          {/* Energy selector */}
          <View style={{ marginTop: layout.spacing.xl }}>
            <Text style={styles.energyHint}>
              Your energy tells the coach how to advise you.
            </Text>
            <Text style={[styles.energySectionLabel, { color: colors.textMuted }]}>HOW'S YOUR ENERGY?</Text>
            <View style={styles.energyRow}>
              {[1, 2, 3, 4, 5].map(n => (
                <TouchableOpacity
                  key={n}
                  style={[
                    styles.energyBox,
                    energyScore === n && {
                      backgroundColor: colors.surfaceElevated,
                      borderColor: colors.borderActive,
                    },
                  ]}
                  onPress={() => {
                    // Smooth the banner + exercise list rejig as the energy
                    // (and the derived reductions) change.
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setEnergyScore(n);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.energyBoxText, energyScore === n && { color: colors.textPrimary }]}>
                    {n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[styles.energyFeeling, { color: colors.textMuted }]}>{FEELING_WORDS[energyScore]}</Text>
          </View>

          {/* Readiness narration — surfaces the autoregulator's session-level
              stance before Start. Pure, derived from energyScore via
              buildReadinessNarration; null on baseline (energy=3) so we
              don't nag with a banner that says "nothing changed". Themed
              by stance: conservative → amber (autoregulator pulling things
              down), green → emerald positive. */}
          {(() => {
            const readiness = buildReadinessNarration(energyScore);
            if (!readiness) return null;
            const accent =
              readiness.stance === 'conservative'
                ? colors.accentAmber
                : colors.accentPositive;
            return (
              <View
                style={[
                  styles.readinessCallout,
                  { borderColor: accent, backgroundColor: colors.surface },
                ]}
              >
                <Text style={[styles.readinessKicker, { color: accent }]}>
                  COACH · {readiness.stance === 'conservative' ? 'CONSERVATIVE TODAY' : 'GREEN LIGHT'}
                </Text>
                <Text style={[styles.readinessBody, { color: colors.textPrimary }]}>
                  {readiness.text}
                </Text>
              </View>
            );
          })()}

          {/* Contextual banner */}
          {banner.kind === 'first_week' && (
            <View style={[styles.coachBanner, { borderColor: colors.accentAmber + '40' }]}>
              <Text style={[styles.coachBannerTitle, { color: colors.accentAmber }]}>★ FIRST WEEK</Text>
              <Text style={styles.coachBannerBody}>
                The coach is learning your patterns. Insights get sharper after each session.
              </Text>
            </View>
          )}
          {banner.kind === 'energy_high' && (
            <View style={[styles.coachBanner, { borderColor: colors.accentAmber }]}>
              <Text style={[styles.coachBannerTitle, { color: colors.accentAmber }]}>⚡ LOCKED IN</Text>
              <Text style={styles.coachBannerBody}>
                {banner.setsAdded > 0
                  ? `Coach added ${banner.setsAdded} set${banner.setsAdded > 1 ? 's' : ''} — you're locked in. Want more?`
                  : 'Want to push harder today?'}
              </Text>
              <View style={styles.coachBannerActions}>
                <TouchableOpacity
                  style={[styles.coachActionBtn, { borderColor: colors.accentAmber }]}
                  onPress={openAddExercise}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.coachActionText, { color: colors.accentAmber }]}>+ Add exercise</Text>
                </TouchableOpacity>
                {banner.addSetTarget ? (
                  <TouchableOpacity
                    style={[styles.coachActionBtn, { borderColor: colors.accentAmber }]}
                    onPress={() => addSetToTarget(banner.addSetTarget!)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.coachActionText, { color: colors.accentAmber }]}>
                      + Add set to {banner.addSetTarget.split(' ').slice(-1)[0]}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          )}
          {banner.kind === 'energy_low' && (
            <View style={[styles.coachBanner, { borderColor: colors.accentTeal + '40' }]}>
              <Text style={[styles.coachBannerTitle, { color: colors.accentTeal }]}>💧 LOW ENERGY</Text>
              <Text style={styles.coachBannerBody}>
                {formatLowEnergyBanner(banner.reduction.setsCut, banner.reduction.exerciseDropped)}
              </Text>
            </View>
          )}
          {banner.kind === 'energy_steady' && (
            <View style={[
              styles.coachBanner,
              { borderColor: banner.tone === 'sharp' ? colors.accentTeal + '40' : colors.cardBorder },
            ]}>
              <Text
                style={[
                  styles.coachBannerTitle,
                  { color: banner.tone === 'sharp' ? colors.accentTeal : colors.textSecondary },
                ]}
              >
                {banner.tone === 'sharp' ? '◆ COACH' : '· COACH'}
              </Text>
              <Text style={styles.coachBannerBody}>
                {banner.repBump > 0
                  ? `${banner.line} Coach bumped reps +${banner.repBump} on every set.`
                  : banner.line}
              </Text>
            </View>
          )}

          {/* Today's session — exercise list with per-exercise coach hints */}
          <Text style={[styles.sessionHeader, { color: colors.textMuted }]}>TODAY'S SESSION</Text>
          <View style={styles.sessionList}>
            {effectiveExercises.map((ex, idx) => {
              const hint = coachHints[ex.name] ?? '';
              return (
                <View key={`${ex.name}-${idx}`} style={styles.sessionRow}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.sessionRowTop}>
                      <Text style={styles.sessionExName} numberOfLines={1}>{ex.name}</Text>
                      <Text style={styles.sessionExSetsReps}>{ex.sets} × {ex.reps}</Text>
                    </View>
                    {/* Cap raised from 2 → 4 lines. The prescription
                        coach line composes (last weight, energy band,
                        suggested) PLUS the "Week N on this lift — chase
                        one more rep than last time." block-week suffix;
                        two lines clip the tail. */}
                    <Text style={styles.sessionHint} numberOfLines={4}>
                      <Text style={{ color: colors.accentTeal }}>Coach: </Text>
                      {hint}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.swapIconBtn}
                    onPress={() => openPreScreenSwap(idx)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.swapIconText}>⇄</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>

          <TouchableOpacity
            style={[styles.workoutStartBtn, { backgroundColor: colors.accentTeal, marginTop: layout.spacing.xl }]}
            onPress={() => handleStartWorkout()}
            activeOpacity={0.8}
          >
            <Text style={styles.workoutStartBtnText}>START WORKOUT</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Swap exercise modal (also used by the active-phase swap button) */}
        <Modal visible={swapModalVisible} animationType="slide" transparent onRequestClose={() => { setSwapModalVisible(false); setSwapTargetIndex(null); }}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalSheet}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Swap exercise</Text>
              <FlatList
                data={swapAlternatives}
                keyExtractor={item => item.id}
                style={{ maxHeight: 400 }}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.swapOption}
                    onPress={() => (swapTargetIndex !== null ? confirmPreScreenSwap(item) : confirmSwap(item))}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.swapOptionName}>{item.name}</Text>
                    <Text style={styles.swapOptionDetail}>{item.sets} × {item.reps} · {item.equipment}</Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <Text style={{ fontFamily: typography.family.body, color: colors.textMuted, textAlign: 'center', padding: layout.spacing.lg }}>
                    No alternatives found
                  </Text>
                }
              />
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => { setSwapModalVisible(false); setSwapTargetIndex(null); }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Add exercise modal */}
        <Modal visible={addExerciseModalVisible} animationType="slide" transparent onRequestClose={() => setAddExerciseModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalSheet}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Add an exercise</Text>
              <FlatList
                data={addExerciseOptions}
                keyExtractor={item => item.id}
                style={{ maxHeight: 400 }}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.swapOption}
                    onPress={() => confirmAddExercise(item)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.swapOptionName}>{item.name}</Text>
                    <Text style={styles.swapOptionDetail}>{item.sets} × {item.reps} · {item.equipment}</Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <Text style={{ fontFamily: typography.family.body, color: colors.textMuted, textAlign: 'center', padding: layout.spacing.lg }}>
                    No more exercises for today's muscle groups
                  </Text>
                }
              />
              <TouchableOpacity style={styles.modalCancel} onPress={() => setAddExerciseModalVisible(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // ─── WEIGHT LOG PHASE ──────────────────────────────────────────────

  // Weight is now logged inline via weightPhaseForEx state in the active view.

  // ─── COMPLETE PHASE ────────────────────────────────────────────────

  if (phase === 'complete') {
    const duration = startTime ? Math.floor((Date.now() - startTime) / 60000) : 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const peakLoad = Object.values(weightLog).reduce((max, w) => {
      const n = parseFloat(w);
      return !isNaN(n) && n > max ? n : max;
    }, 0);
    const shareMuscleGroups = [...new Set(workout.map(e => e.primaryMuscle.toUpperCase()))].slice(0, 3);

    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: 120 }}>
          <View style={[styles.shareCard, { backgroundColor: colors.background }]}>
            {/* Animated Logo */}
            <View style={{ alignItems: 'center', marginBottom: layout.spacing.lg }}>
              <Animated.View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  backgroundColor: colors.surface,
                  justifyContent: 'center',
                  alignItems: 'center',
                  transform: [{ scale: logoScale }],
                  opacity: logoGlow.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.6, 1],
                  }),
                  borderWidth: 1,
                  borderColor: colors.cardBorder,
                }}
              >
                <Text style={{ fontFamily: typography.family.heading, fontSize: 28, color: colors.accentTeal }}>L</Text>
              </Animated.View>
            </View>

            <Text style={[styles.completeTitle, { color: colors.textPrimary }]}>Workout Complete</Text>
            <Text style={[styles.completeType, { color: colors.accentTeal }]}>{planDay?.workoutType ?? 'Workout'}</Text>

            {/* Honest sync status. When the workout_sessions / exercise_logs
                writes fail after a retry, finishWorkout queues the full save
                (weights + RIR included) and sets syncFailed. We tell the
                user — they should know their data is preserved but not yet
                synced, and flushPendingSaves will retry on next focus. */}
            {syncFailed && (
              <View
                style={{
                  marginTop: layout.spacing.sm,
                  marginHorizontal: layout.spacing.lg,
                  padding: layout.spacing.md,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: colors.accentAmber,
                  backgroundColor: colors.surface,
                }}
              >
                <Text
                  style={{
                    fontFamily: typography.family.bodyMedium,
                    fontSize: 13,
                    color: colors.accentAmber,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                    marginBottom: 4,
                  }}
                >
                  Couldn't sync
                </Text>
                <Text
                  style={{
                    fontFamily: typography.family.body,
                    fontSize: 14,
                    color: colors.textPrimary,
                    lineHeight: 20,
                  }}
                >
                  Saved locally with your weights and RIR. We'll retry next time you open the app.
                </Text>
              </View>
            )}

            {/* Stats grid */}
            <View style={styles.statsGrid}>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>{workout.length}</Text>
                <Text style={styles.statLabel}>Exercises</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>{workout.reduce((s, ex) => s + ex.sets, 0)}</Text>
                <Text style={styles.statLabel}>Sets</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>
                  {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
                </Text>
                <Text style={styles.statLabel}>Duration</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, { color: colors.accentAmber }]}>
                  {peakLoad > 0 ? `${peakLoad}kg` : '--'}
                </Text>
                <Text style={styles.statLabel}>Peak Load</Text>
              </View>
            </View>

            {/* PR celebration cards */}
            {newPRs.length > 0 && (
              <View style={{ marginTop: layout.spacing.md, gap: 8 }}>
                {newPRs.map(pr => {
                  // Committed logged weight — the exact number persisted to
                  // exercise_logs (snapshotted from logRows in Phase 5), not
                  // a weightLog lookup that can be stale or name-mismatched.
                  const newWeight = prWeights[pr] ?? NaN;
                  const prev = lastWeights[pr]?.weight;
                  const delta = !isNaN(newWeight) && prev !== undefined ? newWeight - prev : null;
                  return (
                    <View key={pr} style={styles.prCard}>
                      <View style={styles.prCornerGlow} />
                      <Text style={styles.prLabel}>★ NEW BEST · 8 WK</Text>
                      <View style={styles.prRow}>
                        <Text style={styles.prName} numberOfLines={1}>{pr}</Text>
                        {!isNaN(newWeight) && (
                          <Text style={styles.prWeight}>{newWeight} <Text style={styles.prWeightUnit}>kg</Text></Text>
                        )}
                      </View>
                      {delta !== null && delta > 0 && (
                        <Text style={styles.prDelta}>+{delta.toFixed(delta % 1 === 0 ? 0 : 1)} kg over last session</Text>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            {/* Exercise summary */}
            <View style={{ marginTop: layout.spacing.md }}>
              {workout.map((ex, i) => (
                <View key={`${ex.name}-${i}`} style={styles.exerciseSummaryRow}>
                  <View style={styles.exSummaryIndex}>
                    <Text style={[styles.exSummaryIndexText, { color: i === exIndex ? colors.accentTeal : colors.textMuted }]}>{i + 1}</Text>
                  </View>
                  <View style={styles.exSummaryContent}>
                    <Text style={[styles.exSummaryName, { color: colors.textPrimary }]} numberOfLines={1}>
                      {ex.name}
                    </Text>
                    <Text style={[styles.exSummaryDetail, { color: colors.textMuted }]}>
                      {ex.sets} × {ex.reps}
                      {weightLog[ex.name] === 'bw'
                        ? ' · bodyweight'
                        : weightLog[ex.name]
                          ? ` · ${weightLog[ex.name]}kg`
                          : ''}
                    </Text>
                  </View>
                  {weightLog[ex.name] && (
                    <View style={styles.exSummaryCheck}>
                      <Text style={{ color: colors.accentTeal, fontSize: 16 }}>✓</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          </View>

          {/* Action buttons inside ScrollView */}
          <View style={{ paddingHorizontal: layout.spacing.lg, paddingTop: layout.spacing.lg, gap: layout.spacing.sm }}>
            <TouchableOpacity
              style={[styles.ctaBtn, { backgroundColor: colors.accentTeal }]}
              onPress={goHome}
              activeOpacity={0.8}
            >
              <Text style={styles.ctaBtnText}>Back to Home</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setShowShareCard(true)}
              activeOpacity={0.7}
              style={{ alignItems: 'center', paddingVertical: layout.spacing.sm }}
            >
              <Text style={{ fontFamily: typography.family.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
                SHARE SESSION
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        {/* ShareCard overlay */}
        {showShareCard && (
          <ShareCard
            muscleGroups={shareMuscleGroups}
            exerciseCount={workout.length}
            energyScore={energyScore}
            date={todayStr}
            onClose={() => setShowShareCard(false)}
          />
        )}

        {/* The post-workout coach-recap modal used to live here. It moved
            to the dashboard coach card (loaded on home focus from the
            coachMessages store) so the message survives a screen change
            and the user sees it on the next open. The Modal /
            modalOverlay / modalSheet styles are intentionally preserved
            for future actionable nudges; popups are reserved for rare,
            in-the-moment actionable messages, the dashboard coach card
            for reflective ones. */}
      </SafeAreaView>
    );
  }

  // ─── ACTIVE PHASE ─────────────────────────────────────────────────

  if (!currentEx) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ fontFamily: typography.family.heading, color: colors.textSecondary }}>No exercises loaded.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Swap exercise modal */}
      <Modal visible={swapModalVisible} animationType="slide" transparent onRequestClose={() => setSwapModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Swap exercise</Text>
            <FlatList
              data={swapAlternatives}
              keyExtractor={item => item.id}
              style={{ maxHeight: 400 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.swapOption}
                  onPress={() => (swapTargetIndex !== null ? confirmPreScreenSwap(item) : confirmSwap(item))}
                  activeOpacity={0.7}
                >
                  <Text style={styles.swapOptionName}>{item.name}</Text>
                  <Text style={styles.swapOptionDetail}>{item.sets} × {item.reps} · {item.equipment}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={{ fontFamily: typography.family.body, color: colors.textMuted, textAlign: 'center', padding: layout.spacing.lg }}>
                  No alternatives found
                </Text>
              }
            />
            <TouchableOpacity style={styles.modalCancel} onPress={() => setSwapModalVisible(false)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Weight input overlay */}
      {weightPhaseForEx !== null && (() => {
        const currentEx = workout[weightPhaseForEx];
        const exName = currentEx.name;
        const isBodyweight = (currentEx.equipment ?? '').toLowerCase() === 'bodyweight';
        const lastEntry = lastWeights[exName];
        const last = lastEntry?.weight;
        // Note: the "N days ago" label and lastDate were used by the
        // popup's LAST display; that's been moved to the exercise view
        // (see activeExLastUsed). `last` is still needed for the weight
        // pills (-2.5 / same / +2.5 / +5).

        const setInput = (n: number) => {
          const clamped = Math.max(0, Number(n.toFixed(2)));
          setCurrentWeightInput(String(clamped));
        };

        return (
          <View style={styles.weightOverlay}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.weightOverlayKav}
            >
              <ScrollView
                contentContainerStyle={styles.weightOverlayScroll}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={[styles.weightCard, { backgroundColor: colors.surface }]}>
                  <Text style={[styles.weightExTitle, { color: colors.textSecondary }]}>{exName}</Text>

              {isBodyweight ? (
                // ── Bodyweight branch: no kg input, single confirmation tap ──
                <>
                  <Text style={[styles.weightLabel, { color: colors.textMuted, marginTop: layout.spacing.md, marginBottom: layout.spacing.sm }]}>
                    THIS SESSION
                  </Text>
                  <View style={[styles.weightInputRedesign, {
                    borderColor: colors.cardBorder,
                    backgroundColor: colors.background,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }]}>
                    <Text style={{
                      fontFamily: typography.family.heading,
                      fontSize: 20,
                      color: colors.accentTeal,
                      letterSpacing: 1,
                    }}>
                      BODYWEIGHT
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={[styles.weightConfirmBtn, { backgroundColor: colors.accentTeal, marginTop: layout.spacing.md }]}
                    onPress={() => {
                      // Mark exercise as logged for the completion checkmark.
                      // 'bw' is non-numeric, so finishWorkout's logRows filter
                      // (parseFloat check) skips it for exercise_logs writes.
                      commitWeight(exName, 'bw');
                      setCurrentWeightInput('');
                      setWeightPhaseForEx(null);
                      if (exIndex < workout.length - 1) {
                        const restSecs = workout[exIndex]?.restSeconds ?? 60;
                        setExIndex(p => p + 1);
                        startRest(restSecs);
                      } else {
                        finishWorkout();
                      }
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.weightConfirmText, { color: colors.background }]}>Done · Continue</Text>
                  </TouchableOpacity>
                </>
              ) : (
                // ── Weighted branch: kg input + adjust chips ──
                <>
                  {/* Header — the "LAST · …" label that used to live here
                      moved to the exercise view so the historical anchor is
                      visible while the user is deciding what to load, not
                      surfaced after they've already opened the log popup. */}
                  <Text style={[styles.weightLabel, { color: colors.textMuted, marginBottom: layout.spacing.sm }]}>
                    THIS SESSION
                  </Text>

                  <TextInput
                    style={[
                      styles.weightInputRedesign,
                      { color: colors.textPrimary, borderColor: currentWeightInput ? colors.accentTeal : colors.cardBorder },
                    ]}
                    placeholder="kg"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    value={currentWeightInput}
                    onChangeText={setCurrentWeightInput}
                    autoFocus
                    selectTextOnFocus
                  />

                  {last !== undefined && (
                    <View style={styles.weightPillRow}>
                      <TouchableOpacity style={styles.weightPill} onPress={() => setInput(last - 2.5)} activeOpacity={0.7}>
                        <Text style={styles.weightPillText}>-2.5</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.weightPill, currentWeightInput === String(last) && styles.weightPillTeal]}
                        onPress={() => setInput(last)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.weightPillText, currentWeightInput === String(last) && { color: colors.accentTeal }]}>same</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.weightPill} onPress={() => setInput(last + 2.5)} activeOpacity={0.7}>
                        <Text style={styles.weightPillText}>+2.5</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.weightPill} onPress={() => setInput(last + 5)} activeOpacity={0.7}>
                        <Text style={styles.weightPillText}>+5</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* Prescription rationale — explains the pre-fill so the
                      user sees the coach reasoning, not a magic number.
                      Same voice as the pre-screen list: a swapped-in lift
                      with no prescription gets the no_history calibration
                      line instead of going blank, and a low-energy backoff
                      gets energy-framed copy, not the failure line. */}
                  <Text style={[styles.prescriptionNote, { color: colors.accentTeal }]}>
                    {coachLineForPrescription(prescriptions[exName], {
                      exerciseName: exName,
                      lastWeightKg: last,
                      energyScore,
                      blockWeek,
                    })}
                  </Text>

                  {/* RIR capture — single tap commits the set. Each chip
                      records weight + RIR and advances; tapping a chip IS
                      logging the set. The legacy "Log · Continue" button
                      is gone — its job is now the chip itself, which means
                      every successful log carries a real RIR signal instead
                      of the default-Solid noise.
                      Two deliberate secondary actions remain:
                       • "Log without rating" — the user truly doesn't want
                         to rate this set; the weight still gets recorded
                         and the coach receives null (no signal) for next
                         session.
                       • "Skip this set"     — no log at all.
                      Both are smaller text links so accidental taps are
                      unlikely. */}
                  <Text
                    style={[
                      styles.rirHeader,
                      { color: colors.textPrimary, marginTop: layout.spacing.lg },
                    ]}
                  >
                    How hard was that set?
                  </Text>
                  <Text style={[styles.rirHelper, { color: colors.textMuted }]}>
                    The coach uses this to set next session's weight.
                  </Text>

                  <View style={styles.rirRowBig}>
                    {([
                      // Each chip is permanently color-coded — accent on
                      // border AND text — because the single-tap commit
                      // means a chip is never visually "selected" long
                      // enough to flip into color. The resting state IS
                      // the colored state. activeOpacity=0.6 gives a brief
                      // pressed-flash on tap; on commit the popup tears
                      // down so no extended "selected" look is needed.
                      // accentPositive (emerald) lives in src/theme/index.ts.
                      { label: 'Failed', sub: '0 left',   rir: 0, color: colors.accentRed      },
                      { label: 'Hard',   sub: '1 left',   rir: 1, color: colors.accentAmber    },
                      { label: 'Solid',  sub: '2–3 left', rir: 2, color: colors.accentTeal     },
                      { label: 'Easy',   sub: '4+ left',  rir: 3, color: colors.accentPositive },
                    ] as const).map(opt => {
                      return (
                        <TouchableOpacity
                          key={opt.rir}
                          // Permanent per-chip accent on border. 1.5px so
                          // the color reads clearly against the dark
                          // surface; fill stays dark so the contrast lives
                          // in the border + label.
                          style={[
                            styles.rirChipBig,
                            { borderColor: opt.color, borderWidth: 1.5 },
                          ]}
                          // One tap commits both the weight and the RIR.
                          onPress={() => commitWithRir(opt.rir)}
                          // Brief flash on press — accent stays, dim
                          // momentarily so the tap is felt without
                          // requiring a "selected" hold.
                          activeOpacity={0.6}
                          accessibilityRole="button"
                          accessibilityLabel={`${opt.label} — log set with ${opt.sub} in the tank`}
                        >
                          <Text
                            // Label always renders in the chip's accent.
                            // Bright accent against dark surface clears
                            // WCAG AA contrast for body text.
                            style={[styles.rirChipBigLabel, { color: opt.color }]}
                            // Wrapping was the historical visual bug:
                            // "Failed" wrapped to "Faile / d" on narrow
                            // chips. Pin to one line; RN downscales before
                            // it would wrap.
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.78}
                            allowFontScaling={false}
                          >
                            {opt.label}
                          </Text>
                          <Text
                            // Sub-label stays muted so the hierarchy reads
                            // label > sub. The chip's accent shows in the
                            // label and the border — the sub doesn't need
                            // to also carry it.
                            style={[styles.rirChipBigSub, { color: colors.textMuted }]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.7}
                            allowFontScaling={false}
                          >
                            {opt.sub}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Secondary actions. Smaller, separated, deliberate. */}
                  <View style={styles.rirSecondaryRow}>
                    <TouchableOpacity
                      onPress={() => commitWithRir(null)}
                      activeOpacity={0.7}
                      hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
                    >
                      <Text style={[styles.rirSecondaryText, { color: colors.textSecondary }]}>
                        Log without rating
                      </Text>
                    </TouchableOpacity>
                    <Text style={[styles.rirSecondaryDivider, { color: colors.textMuted }]}>·</Text>
                    <TouchableOpacity
                      onPress={skipWeightLog}
                      activeOpacity={0.7}
                      hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
                    >
                      <Text style={[styles.rirSecondaryText, { color: colors.textMuted }]}>
                        Skip this set
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          </View>
        );
      })()}

      {/* Progress bar */}
      <View style={[styles.progressBar, { backgroundColor: colors.surface }]}>
        <View style={[styles.progressFill, { width: `${progressPct * 100}%`, backgroundColor: colors.accentTeal }]} />
      </View>

      {/* Rest timer — prominent centered card, only rendered while resting.
          Presentation only: the interval / cleanup logic (startRest /
          clearRest / functional setRestLeft updater) is untouched. */}
      {restLeft !== null && (
        <View style={styles.restTimerOverlay} pointerEvents="box-none">
          <View style={styles.restTimerCard}>
            <Text style={styles.restTimerLabelBig}>REST</Text>
            <Text style={styles.restTimerCountBig}>{formatRest(restLeft)}</Text>
            <View style={styles.restTimerActionsRow}>
              <TouchableOpacity style={styles.restTimerBtnBig} onPress={() => addRestTime(15)} activeOpacity={0.7}>
                <Text style={styles.restTimerBtnTextBig}>+15s</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.restTimerBtnBig} onPress={skipRest} activeOpacity={0.7}>
                <Text style={styles.restTimerBtnTextBig}>Skip</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      <View style={[styles.activeContainer, { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 }]}>
        {/* Exercise image — falls back to a neutral placeholder block when
            the remote URL 404s or fails to load. The placeholder keeps the
            card layout stable; without it a broken image was rendering as
            either a blank slot or a stale frame. */}
        {currentEx.imageUrl && (
          brokenImageUrls.has(currentEx.imageUrl) ? (
            <View
              style={[
                styles.exerciseImageActive,
                { backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' },
              ]}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                {currentEx.name}
              </Text>
            </View>
          ) : (
            <Image
              source={{ uri: currentEx.imageUrl }}
              style={styles.exerciseImageActive}
              resizeMode="cover"
              onError={() => markImageBroken(currentEx.imageUrl!)}
            />
          )
        )}

        {/* Title row — name on the left, swap icon on the right */}
        <View style={styles.activeTitleRow}>
          <Text style={[styles.activeExName, { color: colors.textPrimary, flex: 1 }]} numberOfLines={2}>
            {currentEx.name}
          </Text>
          <TouchableOpacity
            style={styles.activeSwapIcon}
            onPress={openSwapModal}
            activeOpacity={0.7}
          >
            <Text style={styles.activeSwapIconGlyph}>⇄</Text>
          </TouchableOpacity>
        </View>

        {/* Sets × reps */}
        <Text style={[styles.activeExSetsReps, { color: colors.textSecondary }]}>{currentEx.sets} × {currentEx.reps}</Text>

        {/* Last-used reference — surfaced BEFORE the user opens the log
            popup so the historical anchor informs the weight they pick,
            not just the prescription prefill they see after. Renders
            nothing when there's no history (no dangling "Last:" label).
            Data comes from lastWeights, populated in fetchTodayPlan. */}
        {(() => {
          const last = lastWeights[currentEx.name];
          if (!last || !last.weight) return null;
          const ago = formatLastUsedAgo(last.date);
          return (
            <Text style={[styles.activeExLastUsed, { color: colors.textMuted }]} numberOfLines={1}>
              Last: <Text style={{ color: colors.textSecondary }}>{last.weight} kg</Text>
              {ago ? ` · ${ago}` : ''}
            </Text>
          );
        })()}

        {/* Per-exercise coach hint — same teal prefix as the pre-screen so
            the user reads it as the same voice. Skipped when absent so we
            never show a dangling "Coach:" label. */}
        {coachHints[currentEx.name] ? (
          // Cap raised from 2 → 4 lines to match the pre-screen list
          // (sessionHint at ~1547). The coach line composes prescription
          // copy + the optional "Week N on this lift…" block-week
          // suffix; two lines clipped the tail on long compounds.
          <Text style={styles.activeCoachHint} numberOfLines={4}>
            <Text style={{ color: colors.accentTeal }}>Coach: </Text>
            <Text style={{ color: colors.textSecondary }}>{coachHints[currentEx.name]}</Text>
          </Text>
        ) : null}

        {/* Micro-line */}
        <Text style={[styles.microLine, { color: colors.textMuted }]}>{microLine}</Text>

        {/* Muscle group label */}
        <Text style={[styles.muscleTag, { color: colors.textMuted }]}>{currentEx.primaryMuscle.toUpperCase()}</Text>

        <View style={{ flex: 1 }} />

        {/* NEXT EXERCISE — full width */}
        <TouchableOpacity
          style={[styles.nextExBtn, { backgroundColor: colors.accentTeal }]}
          onPress={handleNextExercise}
          activeOpacity={0.8}
        >
          <Text style={styles.nextExBtnText}>NEXT EXERCISE</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────

function makeStyles(colors: any) {
  return StyleSheet.create({
    safeArea: {
      flex: 1,
    },
    // ── Pre phase ────────────────────────────────
    preContainer: {
      flex: 1,
      padding: layout.spacing.lg,
      justifyContent: 'center',
    },
    preScroll: {
      padding: layout.spacing.lg,
      paddingBottom: layout.spacing.xxl,
    },
    energyHint: {
      fontFamily: typography.family.body,
      fontSize: 12,
      color: colors.textSecondary,
      marginBottom: layout.spacing.sm,
      lineHeight: 17,
    },
    coachBanner: {
      marginTop: layout.spacing.lg,
      padding: layout.spacing.md,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      backgroundColor: colors.surface,
    },
    // ── Readiness callout — session-level autoregulation narration ─────
    // Same visual family as coachBanner so the user reads it as a coach
    // voice. Border picks up the stance color inline; the kicker line
    // (e.g. "COACH · CONSERVATIVE TODAY") is the only place the stance
    // word appears, so the body copy stays warm and honest.
    readinessCallout: {
      marginTop: layout.spacing.md,
      padding: layout.spacing.md,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
    },
    readinessKicker: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 1.6,
      marginBottom: 6,
    },
    readinessBody: {
      fontFamily: typography.family.body,
      fontSize: 14,
      lineHeight: 20,
      letterSpacing: 0.1,
    },
    coachBannerTitle: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 2,
      marginBottom: 6,
    },
    coachBannerBody: {
      fontFamily: typography.family.body,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textSecondary,
    },
    coachBannerActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: layout.spacing.sm,
    },
    coachActionBtn: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: layout.smRadius,
      borderWidth: 1,
    },
    coachActionText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 0.5,
    },
    sessionHeader: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 2,
      marginTop: layout.spacing.xl,
      marginBottom: layout.spacing.sm,
    },
    sessionList: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderRadius: layout.cardRadius,
      overflow: 'hidden',
    },
    sessionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: layout.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.cardBorder,
    },
    sessionRowTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: layout.spacing.sm,
      marginBottom: 4,
    },
    sessionExName: {
      flex: 1,
      fontFamily: typography.family.heading,
      fontSize: 14,
      letterSpacing: -0.2,
      color: colors.textPrimary,
    },
    sessionExSetsReps: {
      fontFamily: typography.family.body,
      fontSize: 12,
      color: colors.textSecondary,
      fontVariant: ['tabular-nums'],
    },
    sessionHint: {
      fontFamily: typography.family.body,
      fontSize: 11.5,
      color: colors.textMuted,
      lineHeight: 16,
    },
    // Per-exercise hint shown during the active set. Same sizing as
    // sessionHint but with top margin for the centered active layout and
    // a slightly brighter base color since it lives on the dark surface.
    activeCoachHint: {
      fontFamily: typography.family.body,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 6,
      textAlign: 'center',
      paddingHorizontal: layout.spacing.md,
    },
    swapIconBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swapIconText: {
      fontFamily: typography.family.heading,
      fontSize: 16,
      color: colors.textSecondary,
    },
    preTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xl,
      color: colors.textPrimary,
      letterSpacing: typography.letterSpacing.heading,
    },
    preSubtitle: {
      fontFamily: typography.family.body,
      fontSize: 11,
      color: colors.textMuted,
      textTransform: 'uppercase',
      marginTop: 4,
    },
    energySectionLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 2,
      textTransform: 'uppercase',
      marginBottom: layout.spacing.sm,
    },
    sectionLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    // Muscle pills
    musclePills: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: layout.spacing.sm,
    },
    pill: {
      backgroundColor: colors.surface,
      borderRadius: 2,
      paddingHorizontal: layout.spacing.md,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    pillText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      color: colors.textSecondary,
    },
    microLine: {
      fontFamily: typography.family.body,
      fontSize: 11,
      textAlign: 'left',
      marginTop: 4,
      marginBottom: 2,
    },
    // Energy selector
    energyRow: {
      flexDirection: 'row',
      gap: 10,
      marginTop: layout.spacing.sm,
    },
    energyBox: {
      width: 48,
      height: 48,
      borderRadius: 2,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    energyBoxText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.md,
      color: colors.textMuted,
    },
    energyFeeling: {
      fontFamily: typography.family.body,
      fontSize: 10,
      marginTop: 6,
      textAlign: 'center',
      textTransform: 'uppercase',
      letterSpacing: 2,
    },
    coachCta: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      marginTop: layout.spacing.lg,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: layout.smRadius,
      borderWidth: 1,
      borderColor: colors.accentTeal,
      backgroundColor: colors.surface,
      gap: 6,
    },
    coachCtaArrow: {
      fontFamily: typography.family.heading,
      fontSize: 12,
      color: colors.accentTeal,
    },
    coachCtaText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 1.5,
      color: colors.accentTeal,
    },
    replannedBadge: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 10,
      letterSpacing: 2,
      color: colors.accentTeal,
      marginTop: layout.spacing.lg,
    },
    replanOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.75)',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: layout.spacing.lg,
    },
    replanCard: {
      width: '100%',
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      padding: layout.spacing.xl,
    },
    replanEyebrow: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 10,
      letterSpacing: 2,
      color: colors.accentTeal,
      marginBottom: layout.spacing.sm,
    },
    replanTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.md + 1,
      color: colors.textPrimary,
      lineHeight: 24,
      letterSpacing: -0.2,
      marginBottom: layout.spacing.md,
    },
    replanBody: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      lineHeight: 20,
      marginBottom: layout.spacing.md,
    },
    replanChangeList: {
      marginBottom: layout.spacing.md,
      gap: 4,
    },
    replanChange: {
      fontFamily: typography.family.body,
      fontSize: 13.5,
      color: colors.textPrimary,
      lineHeight: 20,
    },
    replanUsage: {
      fontFamily: typography.family.body,
      fontSize: 10.5,
      letterSpacing: 1.5,
      color: colors.textMuted,
      marginBottom: layout.spacing.md,
      textAlign: 'right',
    },
    replanPrimaryBtn: {
      paddingVertical: 14,
      borderRadius: layout.cardRadius,
      alignItems: 'center',
      justifyContent: 'center',
    },
    replanPrimaryBtnText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.sm,
      color: colors.background,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    replanGhostBtn: {
      paddingVertical: 12,
      marginTop: layout.spacing.xs,
      alignItems: 'center',
    },
    replanGhostBtnText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textMuted,
    },
    workoutStartBtn: {
      height: 52,
      borderRadius: layout.cardRadius,
      justifyContent: 'center',
      alignItems: 'center',
      flexDirection: 'row',
      paddingHorizontal: layout.spacing.lg,
    },
    workoutStartBtnText: {
      fontFamily: typography.family.heading,
      fontSize: 13,
      color: colors.background,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    // CTA buttons
    ctaBtn: {
      height: 52,
      borderRadius: layout.cardRadius,
      justifyContent: 'center',
      alignItems: 'center',
      flexDirection: 'row',
      paddingHorizontal: layout.spacing.lg,
    },
    ctaBtnText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.sm,
      color: colors.background,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    surfaceBtn: {
      height: 48,
      borderRadius: layout.cardRadius,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.cardBorder,
      backgroundColor: colors.surface,
      paddingHorizontal: layout.spacing.lg,
    },
    surfaceBtnText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
    },
    // Modal sheet
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'flex-end',
    },
    modalSheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: layout.cardRadius,
      borderTopRightRadius: layout.cardRadius,
      padding: layout.spacing.lg,
      paddingBottom: layout.spacing.xl,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderBottomWidth: 0,
    },
    modalHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.textMuted,
      alignSelf: 'center',
      marginBottom: layout.spacing.md,
    },
    modalTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      color: colors.textPrimary,
      marginBottom: layout.spacing.md,
    },
    modalCancel: {
      alignItems: 'center',
      paddingVertical: layout.spacing.sm,
      marginTop: layout.spacing.sm,
    },
    modalCancelText: {
      fontFamily: typography.family.bodyMedium,
      color: colors.textMuted,
      fontSize: typography.size.sm,
    },
    // ── Active phase ─────────────────────────────
    card: {
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
    },
    progressBar: {
      height: 3,
      borderRadius: 1.5,
      marginHorizontal: layout.spacing.lg,
      marginTop: layout.spacing.sm,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 1.5,
    },
    activeContainer: {
      flex: 1,
      justifyContent: 'space-between',
      paddingTop: layout.spacing.lg,
    },
    exerciseImageActive: {
      width: '100%',
      height: 220,
      borderRadius: 2,
      marginBottom: layout.spacing.md,
      backgroundColor: colors.surfaceElevated,
    },
    activeExName: {
      fontFamily: typography.family.heading,
      fontSize: 24,
      color: colors.textPrimary,
      marginBottom: 4,
    },
    activeExSetsReps: {
      fontFamily: typography.family.body,
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: 2,
    },
    activeExLastUsed: {
      // Pre-set historical reference. Mid-weight (textMuted prefix, textSecondary
      // emphasis on the number) so it reads as data, not a coach prompt.
      fontFamily: typography.family.body,
      fontSize: 13,
      lineHeight: 18,
      marginBottom: 6,
      letterSpacing: 0.1,
    },
    muscleTag: {
      fontFamily: typography.family.body,
      fontSize: 11,
      color: colors.textMuted,
      textTransform: 'uppercase',
    },
    activeTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 4,
    },
    activeSwapIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    activeSwapIconGlyph: {
      fontFamily: typography.family.heading,
      fontSize: 18,
      color: colors.textSecondary,
    },
    nextExBtn: {
      height: 52,
      borderRadius: layout.cardRadius,
      justifyContent: 'center',
      alignItems: 'center',
    },
    nextExBtnText: {
      fontFamily: typography.family.heading,
      fontSize: 13,
      color: colors.background,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    restTimerBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: layout.spacing.lg,
      paddingVertical: 10,
    },
    restTimerLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 2,
      color: colors.textMuted,
    },
    restTimerCount: {
      fontFamily: typography.family.heading,
      fontSize: 20,
      color: colors.accentTeal,
      flex: 1,
    },
    restTimerBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: layout.smRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
    },
    restTimerBtnText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 12,
      color: colors.textSecondary,
    },
    // ── Centered rest-timer overlay ─────────────────────────────────
    restTimerOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 90,
    },
    restTimerCard: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderRadius: layout.cardRadius,
      paddingVertical: layout.spacing.xl,
      paddingHorizontal: layout.spacing.xl,
      alignItems: 'center',
      minWidth: 220,
    },
    restTimerLabelBig: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 12,
      letterSpacing: 3,
      color: colors.textMuted,
      marginBottom: layout.spacing.sm,
    },
    restTimerCountBig: {
      fontFamily: typography.family.heading,
      fontSize: 64,
      lineHeight: 68,
      color: colors.accentTeal,
      letterSpacing: 1,
      marginBottom: layout.spacing.lg,
    },
    restTimerActionsRow: {
      flexDirection: 'row',
      gap: 12,
    },
    restTimerBtnBig: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: layout.smRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
    },
    restTimerBtnTextBig: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 14,
      color: colors.textSecondary,
      letterSpacing: 0.5,
    },
    weightOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      zIndex: 100,
    },
    weightOverlayKav: {
      flex: 1,
      width: '100%',
    },
    weightOverlayScroll: {
      flexGrow: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: layout.spacing.lg,
    },
    weightCard: {
      width: '80%',
      borderRadius: layout.cardRadius,
      padding: layout.spacing.lg,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      alignItems: 'center',
    },
    weightExTitle: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 12,
      textTransform: 'uppercase',
      marginBottom: layout.spacing.md,
    },
    weightLabel: {
      fontFamily: typography.family.body,
      fontSize: 10,
      letterSpacing: 1,
      marginBottom: layout.spacing.sm,
    },
    weightHeaderRow: {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 4,
    },
    weightPillRow: {
      flexDirection: 'row',
      gap: 6,
      alignSelf: 'flex-start',
      marginBottom: layout.spacing.md,
    },
    rirRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: layout.spacing.sm,
      marginBottom: layout.spacing.md,
    },
    rirChip: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: layout.smRadius,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
    },
    rirChipActive: {
      borderColor: colors.accentTeal,
      backgroundColor: colors.surface,
    },
    rirChipText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      color: colors.textMuted,
      letterSpacing: 0.5,
    },
    // ── Redesigned RIR commit block ─────────────────────────────────────
    // Sized so the chips are the visual anchor of the weight phase, not a
    // footer afterthought. One tap on a chip logs the set with that RIR.
    rirHeader: {
      fontFamily: typography.family.heading,
      fontSize: 18,
      letterSpacing: 0.2,
      marginBottom: 4,
      textAlign: 'left',
    },
    rirHelper: {
      fontFamily: typography.family.body,
      fontSize: 12,
      lineHeight: 16,
      marginBottom: layout.spacing.md,
    },
    rirRowBig: {
      flexDirection: 'row',
      // 6px gap × 3 = 18px total. With the weight card's horizontal padding
      // (~16px each side from weightOverlayScroll), even a 360px screen
      // leaves ~310px for chip content → ~73px per chip. Plenty of room.
      gap: 6,
      marginBottom: layout.spacing.md,
    },
    rirChipBig: {
      flex: 1,
      paddingVertical: 12,
      // 4px horizontal padding lets short labels ('Hard', 'Easy') breathe
      // and longer ones ('Failed', '2–3 left') still fit one line thanks
      // to adjustsFontSizeToFit downscaling instead of wrapping.
      paddingHorizontal: 4,
      // Consistent corner radius across all four chips and the same radius
      // family as other interactive surfaces on the weight popup.
      borderRadius: layout.smRadius,
      // Border width is locked at 1.5 to match the per-chip accent style
      // inlined in the JSX. Border COLOR is overridden per-chip with the
      // accent (red/amber/teal/positive) so the resting state already shows
      // the semantic color — the single-tap commit never gives a "selected"
      // state long enough to flip it.
      borderWidth: 1.5,
      borderColor: colors.cardBorder,
      // Dark fill: contrast lives in the colored border + colored label.
      // Tinting the fill would mute the accent against the obsidian theme.
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 62,
    },
    // rirChipBigActive — kept for back-compat with any external reference,
    // but no longer used by the weight popup. The chip's resting state IS
    // its accent state (see the JSX above).
    rirChipBigActive: {
      borderColor: colors.accentTeal,
      backgroundColor: colors.surfaceElevated,
      borderWidth: 1.5,
    },
    rirChipBigLabel: {
      fontFamily: typography.family.heading,
      // 13px (down from 14) so 'Failed' fits comfortably on a 360px screen
      // with the keyboard up; adjustsFontSizeToFit handles the rest.
      fontSize: 13,
      letterSpacing: 0.2,
      marginBottom: 2,
      textAlign: 'center',
    },
    rirChipBigSub: {
      fontFamily: typography.family.body,
      // 10px sub stays clearly subordinate to the 13px label — the size
      // gap is what reads "secondary" in addition to the muted color.
      fontSize: 10,
      lineHeight: 12,
      letterSpacing: 0.2,
      textAlign: 'center',
    },
    rirSecondaryRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 8,
      marginTop: 2,
      marginBottom: layout.spacing.sm,
    },
    rirSecondaryText: {
      fontFamily: typography.family.body,
      fontSize: 12,
      letterSpacing: 0.2,
      paddingVertical: 6,
    },
    rirSecondaryDivider: {
      fontFamily: typography.family.body,
      fontSize: 14,
      opacity: 0.6,
    },
    prescriptionNote: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 12,
      letterSpacing: 0.3,
      marginTop: -layout.spacing.sm,
      marginBottom: layout.spacing.sm,
    },
    weightPill: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: layout.pillRadius,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    weightPillTeal: {
      borderColor: colors.accentTeal,
    },
    weightPillText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 11,
      letterSpacing: 0.4,
      color: colors.textSecondary,
    },
    weightInputRedesign: {
      width: '100%',
      height: 52,
      borderRadius: layout.smRadius,
      borderWidth: 1,
      backgroundColor: colors.background,
      paddingHorizontal: layout.spacing.md,
      fontFamily: typography.family.heading,
      fontSize: 20,
      textAlign: 'center',
      marginBottom: layout.spacing.md,
    },
    weightConfirmBtn: {
      width: '100%',
      height: 48,
      borderRadius: layout.cardRadius,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: layout.spacing.sm,
    },
    weightConfirmText: {
      fontFamily: typography.family.heading,
      fontSize: 12,
      letterSpacing: 1,
    },
    weightSkipText: {
      fontFamily: typography.family.body,
      fontSize: 12,
      paddingVertical: 4,
    },
    // Swap options
    swapOption: {
      paddingVertical: layout.spacing.md,
      paddingHorizontal: layout.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.cardBorder,
    },
    swapOptionName: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.sm,
      color: colors.textPrimary,
    },
    swapOptionDetail: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      color: colors.textMuted,
      marginTop: 2,
    },
    // ── Complete phase ───────────────────────────
    shareCard: {
      padding: layout.spacing.lg,
      marginHorizontal: layout.spacing.lg,
      marginTop: layout.spacing.md,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
    },
    completeTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      textAlign: 'center',
    },
    completeType: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
      textAlign: 'center',
      marginTop: 4,
    },
    statsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: layout.spacing.lg,
    },
    statBox: {
      flex: 1,
      minWidth: '45%',
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      padding: layout.spacing.md,
      alignItems: 'center',
    },
    statValue: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
    },
    statLabel: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xxs || 11,
      color: colors.textMuted,
      marginTop: 2,
    },
    prCard: {
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.accentAmber + '55',
      padding: 16,
      overflow: 'hidden',
      position: 'relative',
    },
    prCornerGlow: {
      position: 'absolute',
      top: -40,
      right: -40,
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: colors.accentAmber + '22',
    },
    prLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 9.5,
      letterSpacing: 2,
      color: colors.accentAmber,
      marginBottom: 6,
    },
    prRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
    },
    prName: {
      fontFamily: typography.family.heading,
      fontSize: 19,
      letterSpacing: -0.4,
      color: colors.textPrimary,
      flex: 1,
    },
    prWeight: {
      fontFamily: typography.family.heading,
      fontSize: 22,
      letterSpacing: -0.5,
      color: colors.textPrimary,
    },
    prWeightUnit: {
      fontFamily: typography.family.body,
      fontSize: 11,
      color: colors.textSecondary,
    },
    prDelta: {
      fontFamily: typography.family.bodyMedium,
      fontSize: 10.5,
      letterSpacing: 0.4,
      color: colors.accentAmber,
      marginTop: 4,
    },
    exerciseSummaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.cardBorder,
    },
    exSummaryIndex: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      justifyContent: 'center',
      alignItems: 'center',
    },
    exSummaryIndexText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xxs || 11,
    },
    exSummaryContent: {
      flex: 1,
      marginLeft: layout.spacing.sm,
    },
    exSummaryName: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
    },
    exSummaryDetail: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xxs || 11,
      marginTop: 1,
    },
    exSummaryCheck: {
      marginLeft: layout.spacing.sm,
    },
  });
}