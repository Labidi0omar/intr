import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
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
import * as haptics from '../src/lib/haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import Button from '../src/components/Button';
import { EXERCISES } from '../src/constants/exercises';
import { useTheme } from '../src/context/ThemeContext';
import { supabase } from '../src/lib/supabase';
import { layout, typography, elevation } from '../src/theme';
import ShareCard from '../src/components/ShareCard';
import MuscleDetails from '../src/components/MuscleDetails';
import { getMuscleInfo } from '../src/constants/muscleInfo';
import { track, getCompletedWorkoutCount } from '../src/lib/analytics';
import { applyEnergyEffect, buildReadinessNarration, coachLineForPrescription, formatLowEnergyBanner, pickBanner, pickCoachHint, type BannerKind } from '../src/lib/coachHints';
import { buildCampaignStatus } from '../src/lib/campaignStatus';
import { buildCoachRecapContext, produceRecapMessage, requestCoachRecap } from '../src/lib/coachRecap';
import { appendCoachMessage, appendCoachMessageOnce , updateCoachMessageTextByFactSig } from '../src/lib/coachMessages';
import { buildSessionPr, type Observation } from '../src/lib/coachObservations';
import { phraseObservation, dedupKeyFor } from '../src/lib/coachVoice';
import { runCoachVoiceUpgrade } from '../src/lib/coachVoiceAI';

import { enqueuePendingSave, runFinishPersistence, type PendingSave } from '../src/lib/pendingSync';
import { computeSessionPrs } from '../src/lib/prDetection';
import { reportSilent } from '../src/lib/errorReporting';
import { prescribeLoad, applyStallNudge, wasFollowed, hitTargetZone, type Prescription } from '../src/lib/loadPrescription';
import { normalizeExName, shouldShowCoachCall, type HistoryLoadState } from '../src/lib/coachCall';
import { ANCHOR_LIFTS, ANCHOR_SEED_NOTES_STORAGE_KEY, type AnchorSeedNote } from '../src/lib/anchorSeed';
import { ANCHOR_BASIS_LABEL, basisForExercise, buildAnchorWorkingWeights, deriveFromAnchors } from '../src/lib/anchorDerivation';
import {
  buildPrescriptionHero,
  type PrescriptionTone,
} from '../src/lib/prescriptionPresenter';
import { generateAdHocDay, isCompoundName, CURRENT_PLAN_VERSION, type AdHocWorkoutType } from '../src/lib/planGeneration';
import { parseBand } from '../src/lib/goalProfile';
import { ensureCurrentWeekPlan } from '../src/lib/planSync';
import { applySwapToRows, extractPlanDays } from '../src/lib/planSwap';
import { secondFrameUrl } from '../src/lib/exerciseImage';
import { abandonModalCopy } from '../src/lib/workoutAbandon';
import { scheduleComebackNotification } from '../src/utils/notifications';
import { normalizeMuscle } from '../src/utils/muscleGroups';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Auto-compute the reps we write into exercise_logs from the plan's rep
 *  string. Product decision: users are not prompted for reps anymore — the
 *  plan says "8-12", so we assume the MIDPOINT (10) and log it. Rounded to
 *  the nearest integer. Returns null for anything we can't parse cleanly
 *  ("30-60s" time-under-tension holds, "AMRAP", garbage) — the caller
 *  writes null to exercise_logs.reps in that case, which is fine: the
 *  history column tolerates nulls and no downstream reader now depends on
 *  reps being present.
 *
 *  IMPORTANT: this value is HISTORY / DISPLAY only. It must never be fed
 *  back into prescribeLoad — the top-of-band gate would see midpoint <
 *  topReps every session and downgrade every 'progress' into a permanent
 *  hold. Progression is intentionally pure RIR-driven now. */
function midpointFromReps(reps: string | number | null | undefined): number | null {
  if (reps == null) return null;
  if (typeof reps === 'number' && Number.isFinite(reps)) return Math.round(reps);
  if (typeof reps !== 'string') return null;
  const trimmed = reps.trim();
  const band = parseBand(trimmed);
  if (band) return Math.round((band.min + band.max) / 2);
  // Bare integer like "10".
  const single = /^\s*(\d+)\s*$/.exec(trimmed);
  if (single) return parseInt(single[1], 10);
  return null;
}

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
  sessionExerciseNames: readonly string[] = [],
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
  /** Optional sub-region emphasis threaded from the catalog through
   *  the plan generator to MuscleDetails. Undefined = no emphasis
   *  (falls back to primaryMuscle's default slug). */
  emphasis?: import('../src/constants/exercises').ExerciseEntry['emphasis'];
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
  // Used to register a `beforeRemove` listener for the workout screen so
  // iOS swipe-back, the header back button, and any other expo-router
  // navigation away (including programmatic `router.back()` from elsewhere)
  // route through the Abandon confirmation modal instead of silently
  // discarding the in-progress session.
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ energy_score?: string; intent_tag?: string; reflection?: string }>();

  const [loadingInitial, setLoadingInitial] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [planDay, setPlanDay] = useState<PlanDay | null>(null);
  const [muscleGroup, setMuscleGroup] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('pre');
  const [energyScore, setEnergyScore] = useState<number>(3);

  // microLine (the energy + intent micro-banner) used to render on the
  // active card alongside the COACH'S CALL hero and a "Coach:" line. The
  // merge collapsed all three into the hero's single reason sentence —
  // buildPrescriptionHero now takes energyScore and emits the energy
  // framing inline. Removed here to avoid an orphaned useMemo recomputing
  // on every energy/intent change.

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
  // Per-exercise reps written on set commit. NO user-facing input — the
  // value is auto-computed as the rounded midpoint of the plan's rep range
  // (e.g. "8-12" → 10, "3-5" → 4) via midpointFromReps below, so
  // exercise_logs still gets useful history without an extra prompt.
  //
  // IMPORTANT: this midpoint is HISTORY / DISPLAY only. It is NOT fed back
  // into prescribeLoad's top-of-band gate — passing an auto-midpoint would
  // freeze that gate at "hold" every session and silently kill all load
  // progression. See the prescribeLoad call site for the explicit skip.
  // The ref+state pattern is kept so finishWorkout's synchronous read still
  // sees the value written this tick on the last exercise.
  const repsLogRef = useRef<Record<string, number>>({});
  const [, setRepsLog] = useState<Record<string, number>>({});
  // Snapshot of the prescription as it was shown to the user. Lets
  // finishWorkout compare suggested vs. actually-logged without recomputing
  // (which would race against changing energyScore / lastWeights mid-session).
  // Keyed by exercise name. Absence = no suggestion was shown for that exercise.
  type ShownRx = {
    suggested_weight_kg: number;
    delta_pct: number;
    rationale: Prescription['rationale'];
    /** Captured so the finish recap can differentiate failure vs
     *  low-energy backoffs without re-reading the prescription engine. */
    cause: Prescription['cause'];
    /** What the engine read as the prior-session weight when this rx was
     *  shown. Pinned at show-time so the recap shift ("80 → 85 kg") is
     *  exact even if lastWeights state updates later in the session. */
    last_weight_kg: number;
    energy_score: number;
  };
  const [shownPrescriptions, setShownPrescriptions] = useState<Record<string, ShownRx>>({});
  const [lastWeights, setLastWeights] = useState<Record<string, { weight: number; date: string; rir: number | null; reps: number | null }>>({});
  // Full per-exercise history (last 6 entries DESC) for coach-hint trend logic.
  // RIR is included on each entry so the coach-recap context builder can
  // surface a per-lift trend with RIR for the model — the data is already in
  // the query, this just keeps it through state instead of dropping it.
  const [exerciseHistory, setExerciseHistory] = useState<Record<string, { weight_kg: number; date: string; rir: number | null }[]>>({});
  // Per-lift session-top weights (date → max kg), OLDEST-FIRST. Built from
  // the same exercise_logs fetch that drives lastWeights/exerciseHistory.
  // Feeds the stall-progression nudge (applyStallNudge) so a lift parked
  // at the same top weight for ≥ STALL_WEEKS while actually trained earns
  // a bump even when last RIR was a clean hold. The grouping uses
  // logged_date as the session key — one session per day per exercise is
  // the working assumption in this codebase, the same one coachObservations
  // uses on the dashboard side.
  const [liftSessionTops, setLiftSessionTops] = useState<Record<string, { topKg: number; date: string }[]>>({});
  // Load status for the initial exercise_logs history fetch. Feeds
  // shouldShowCoachCall so the Coach's Call hero can distinguish "still
  // loading" from "genuinely no history yet." A silent fetch failure
  // used to leave every lift indistinguishable from a cold-start —
  // the whole hero would vanish for a full session with no signal in
  // Sentry beyond the generic fetch tag. See src/lib/coachCall.ts.
  //
  // Transitions:
  //   'loading' (initial) → 'ready' on first successful fetch
  //   'loading'           → 'error' after ONE retry also fails; a
  //                         distinct Sentry tag ('workout:historyFetchEmpty')
  //                         separates outage from cold-start in the dashboard.
  const [historyLoad, setHistoryLoad] = useState<HistoryLoadState>('loading');
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
  // "PR detection is in flight." Set true when finishWorkout flips
  // phase → 'complete' optimistically (immediately after the in-memory
  // save is built) and cleared when computeSessionPrs settles — success
  // OR failure. The summary card reads it to render a subtle inline
  // "Checking for PRs…" placeholder while the durable-save + prior-log
  // fetch resolve, so the user sees the complete screen instantly but
  // still gets an honest signal that PR celebrations may still arrive.
  const [prCheckPending, setPrCheckPending] = useState(false);
  // Fitness level powers the beginner step-halving inside prescribeLoad so
  // the client's pre-fill matches what the server-side replanner computes.
  const [fitnessLevel, setFitnessLevel] = useState<'beginner' | 'intermediate' | 'advanced' | undefined>(undefined);
  // profiles.goal — read once for the ad-hoc generator (so a "Train anyway"
  // session inherits the user's lane) and for future prescriptionPresenter
  // goal-aware reason lines. Fire-and-forget; undefined means fall back to
  // catalog values, same back-compat contract as the rest of the plumbing.
  const [goal, setGoal] = useState<'strength' | 'muscle' | 'general' | undefined>(undefined);
  // Onboarding anchor-lift attribution notes ("based on your 100×5"),
  // keyed by canonical exercise_name. Read once from AsyncStorage (written
  // by onboarding.tsx at signup); only consumed by the Coach's Call hero
  // when this lift's ENTIRE history is still just that seeded row — see
  // the anchorSeed computation next to the hero render below. Empty object
  // is the common case (most users skip the anchors step, or it's past
  // session one) and is a total no-op.
  const [anchorSeedNotes, setAnchorSeedNotes] = useState<Record<string, AnchorSeedNote>>({});
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

  // Two-frame demo for the active-exercise image. free-exercise-db ships
  // start/end frames as /0.jpg and /1.jpg. Default state is STATIC (frame
  // 0) — the user taps the ▶ button overlaid on the photo to animate the
  // movement, ⏸ to stop. We read the active image via workout[exIndex]
  // (declared above) because the `currentEx` alias is defined further
  // down in the render body. The play state resets to paused on
  // exercise change so every new lift starts as a still.
  const activeImageUrl = workout[exIndex]?.imageUrl;
  const [frameLoopPlaying, setFrameLoopPlaying] = useState(false);
  const [frameToggle, setFrameToggle] = useState(false);
  useEffect(() => {
    setFrameLoopPlaying(false);
    setFrameToggle(false);
  }, [activeImageUrl]);
  useEffect(() => {
    if (!frameLoopPlaying) {
      setFrameToggle(false);
      return;
    }
    const second = secondFrameUrl(activeImageUrl);
    if (!second) return;
    if (brokenImageUrls.has(second)) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    try {
      interval = setInterval(() => setFrameToggle(prev => !prev), 1200);
    } catch (e) {
      reportSilent(e, 'workout:frameLoop');
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [frameLoopPlaying, activeImageUrl, brokenImageUrls]);
  // True when the current exercise actually has a second frame to play —
  // gates the play/pause button so we don't show a control that does
  // nothing on single-position lifts (which only ship /0.jpg).
  const hasSecondFrame = (() => {
    const second = secondFrameUrl(activeImageUrl);
    return !!second && !brokenImageUrls.has(second);
  })();

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
          haptics.success();
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
    // Fresh "today" at memo time so a session opened across midnight reads
    // the right anchor for the stall-weeks computation. Same pattern as
    // the other action-time todayStr sites in this file.
    const todayIso = getTodayStr();
    for (const ex of preScreenReduction.exercises) {
      // Reads normalize on the way in so casing/whitespace drift between
      // plan and DB rows can't silently miss (see COACH_CALL_FIX.md, C).
      const key = normalizeExName(ex.name);
      const last = lastWeights[key];
      if (!last || !last.weight) continue;
      const isCompound = isCompoundName(ex.name);
      // Goal-aware plumbing (v2). All new inputs are optional in
      // PrescriptionInput so an omission collapses to legacy behavior:
      //   - goal: shifts the RIR ladder per lane (strength holds at 1-2
      //     and only backs off on true failure; muscle keeps the 1-hold
      //     ladder; general is a pure passthrough of the pre-goal engine).
      //   - sessionCountForLift: exerciseHistory[key] carries up to 6 prior
      //     entries (from the last-known-good fetch). Under CALIBRATION_
      //     SESSIONS the damper fires (halved step + RIR 0 reframed as hold).
      //
      // TOP-OF-BAND GATE INTENTIONALLY SKIPPED (deliberate dead code).
      // We no longer ask the user for reps performed — exercise_logs.reps is
      // auto-populated with the midpoint of the plan's rep range for
      // history / display only. Feeding that midpoint into `lastReps` here
      // would trip the gate every session (midpoint < topReps → 'progress'
      // downgrades to 'hold'), silently freezing all load increases across
      // the app. The gate needs BOTH lastReps and topReps to fire, so
      // dropping lastReps makes it inert; the code stays in place in case
      // we ever bring back real per-set rep logging. Progression today is
      // pure RIR-driven — the intended product behavior.
      const sessionCountForLift = exerciseHistory[key]?.length ?? 0;
      const base = prescribeLoad({
        lastWeightKg: last.weight,
        lastRir: last.rir,
        energyScore,
        isCompound,
        fitnessLevel,
        goal,
        // topReps + lastReps deliberately omitted — see the block comment above.
        sessionCountForLift,
      });
      // Additive: applyStallNudge passes the rx through unchanged unless
      // every guard clears (would-hold + clean RIR + normal-or-high
      // energy + flat ≥ STALL_WEEKS with real sessions in the run).
      // Failure / low_energy / backoff cases bypass it by construction —
      // see the guards inside the function.
      // The output map key stays as the plan-string ex.name (unchanged
      // API for hero / analytics / prescription_outcome consumers); only
      // the LOOKUP side is normalized.
      out[ex.name] = applyStallNudge({
        base,
        liftHistory: liftSessionTops[key] ?? [],
        lastRir: last.rir,
        energyScore,
        isCompound,
        fitnessLevel,
        todayIso,
      });
    }
    return out;
  }, [preScreenReduction.exercises, lastWeights, liftSessionTops, energyScore, fitnessLevel, goal, exerciseHistory]);

  // The user's current working weight per anchor lift (Bench/Squat/
  // Deadlift/Overhead/Row), read from lastWeights at the five canonical
  // anchor exercise names. Feeds deriveFromAnchors so a no-history lift
  // (e.g. Incline Bench with no logged sets) can seed from what the user
  // told us about a RELATED lift, instead of a blank box OR the removed
  // bodyweight guess. Empty for any anchor the user never seeded/logged —
  // deriveFromAnchors treats a missing key as "not anchored," same as a
  // lift with no map entry at all.
  const anchorWorkingWeights = useMemo(() => {
    const byCanonicalName: Partial<Record<string, number>> = {};
    for (const def of ANCHOR_LIFTS) {
      byCanonicalName[def.exerciseName] = lastWeights[normalizeExName(def.exerciseName)]?.weight;
    }
    return buildAnchorWorkingWeights(byCanonicalName, ANCHOR_LIFTS);
  }, [lastWeights]);

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
        lastWeightKg: lastWeights[normalizeExName(ex.name)]?.weight,
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
  const [showAbandonModal, setShowAbandonModal] = useState(false);
  const [showMuscleDetails, setShowMuscleDetails] = useState(false);

  // When the user confirms "Abandon", we intentionally navigate away —
  // but our own beforeRemove listener will fire on that navigation and
  // would re-intercept it, leaving the user stuck in a modal loop. This
  // ref short-circuits the listener on the next removal.
  const abandonBypassRef = useRef(false);
  // Mirror of `showAbandonModal` for the synchronous BackHandler check.
  // The native listener fires outside of React's render cycle, so it
  // can't read state directly without re-subscribing on every change.
  const modalOpenRef = useRef(false);
  useEffect(() => { modalOpenRef.current = showAbandonModal; }, [showAbandonModal]);


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
          .select('created_at, fitness_level, goal')
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
        const g = (profileRow as { goal?: unknown } | null | undefined)?.goal;
        if (g === 'strength' || g === 'muscle' || g === 'general') {
          setGoal(g);
        }
      } catch (e) {
        // Non-fatal — banner will default to no first-week treatment.
        reportSilent(e, 'workout:fetchProfileMeta');
      }

      // Onboarding anchor-lift attribution notes, if onboarding.tsx wrote
      // any. Best-effort local read — a missing/corrupt cache just means
      // the "based on your X×Y" line never shows, never a crash.
      try {
        const rawNotes = await AsyncStorage.getItem(ANCHOR_SEED_NOTES_STORAGE_KEY);
        if (rawNotes) {
          const parsed: Record<string, AnchorSeedNote> = JSON.parse(rawNotes);
          // Re-key via normalizeExName so the lookup matches lastWeights /
          // exerciseHistory's convention (both keyed by normalized name) —
          // onboarding.tsx writes canonical catalog casing, but this keeps
          // the read side consistent with every other history lookup in
          // this file rather than relying on exact-string equality.
          const renormalized: Record<string, AnchorSeedNote> = {};
          for (const [name, note] of Object.entries(parsed)) {
            renormalized[normalizeExName(name)] = note;
          }
          setAnchorSeedNotes(renormalized);
        }
      } catch (e) {
        reportSilent(e, 'workout:fetchAnchorSeedNotes');
      }

      // Pre-load per-exercise history so coach hints can render immediately
      // on the pre-screen (not delayed until the user taps Start).
      //
      // Reliability contract (see src/lib/coachCall.ts + COACH_CALL_FIX.md):
      //   • Names are keyed via normalizeExName so swapped-in lifts, and
      //     any casing / whitespace drift between plan and log rows, don't
      //     silently miss.
      //   • On failure we retry ONCE, then flip historyLoad to 'error'
      //     and report a distinct Sentry tag so an outage is visible in
      //     the dashboard instead of blending into normal cold-start.
      //   • The query itself is unchanged in shape — this is a client-side
      //     correctness fix, not a schema change.
      setHistoryLoad('loading');
      const exerciseNames = todayPlan.exercises.map(e => e.name);
      const runHistoryFetch = async (): Promise<boolean> => {
        const { data: logs, error } = await supabase
          .from('exercise_logs')
          .select('exercise_name, weight_kg, logged_date, reps_in_reserve, reps')
          .eq('user_id', user.id)
          // EXCLUSION BOUNDARY: load coach must never see recovery weights
          // as "your last set". Drives lastWeights + exerciseHistory.
          .eq('is_recovery', false)
          .in('exercise_name', exerciseNames)
          .order('logged_date', { ascending: false });
        if (error) return false;
        if (!logs) return false;

        const latest: Record<string, { weight: number; date: string; rir: number | null; reps: number | null }> = {};
        const grouped: Record<string, { weight_kg: number; date: string; rir: number | null }[]> = {};
        // Date-keyed max kg per exercise — used to feed applyStallNudge.
        // logged_date IS the session key (one session per day per
        // exercise) so a Map<date, maxKg> collapses N sets to 1 entry.
        const tops: Record<string, Map<string, number>> = {};
        for (const row of logs as any[]) {
          const key = normalizeExName(row.exercise_name);
          if (!key) continue;
          if (!(key in latest)) {
            latest[key] = {
              weight: row.weight_kg,
              date: row.logged_date,
              rir: row.reps_in_reserve ?? null,
              // Reps landed in the schema in migration 20260704000000. Older
              // rows return null; the top-of-band gate treats null as "no
              // history" and falls through to the RIR-only ladder, so this
              // wire is fully back-compat with pre-migration accounts.
              reps: typeof row.reps === 'number' ? row.reps : null,
            };
          }
          if (!grouped[key]) grouped[key] = [];
          if (grouped[key].length < 6) {
            grouped[key].push({
              weight_kg: row.weight_kg,
              date: row.logged_date,
              rir: row.reps_in_reserve ?? null,
            });
          }
          const w = Number(row.weight_kg);
          if (Number.isFinite(w) && w > 0 && row.logged_date) {
            if (!tops[key]) tops[key] = new Map();
            const cur = tops[key].get(row.logged_date) ?? 0;
            if (w > cur) tops[key].set(row.logged_date, w);
          }
        }
        setLastWeights(latest);
        setExerciseHistory(grouped);
        // Convert each date-map to an oldest-first array — the order
        // applyStallNudge expects (it sorts internally too, but
        // pre-sorting here keeps the contract explicit).
        const topsArr: Record<string, { topKg: number; date: string }[]> = {};
        for (const [name, m] of Object.entries(tops)) {
          topsArr[name] = Array.from(m.entries())
            .map(([date, topKg]) => ({ date, topKg }))
            .sort((a, b) => a.date.localeCompare(b.date));
        }
        setLiftSessionTops(topsArr);
        return true;
      };

      let historyOk = false;
      try {
        historyOk = await runHistoryFetch();
      } catch (e) {
        reportSilent(e, 'workout:fetchExerciseHistory');
      }
      if (!historyOk) {
        // Single retry — often catches a transient network blip that
        // otherwise leaves the whole session's coach card blank.
        try {
          historyOk = await runHistoryFetch();
        } catch (e) {
          reportSilent(e, 'workout:fetchExerciseHistory:retry');
        }
      }
      if (historyOk) {
        setHistoryLoad('ready');
      } else {
        setHistoryLoad('error');
        // Distinct tag so this shows up in Sentry as "outage" instead
        // of hiding among ordinary fetchExerciseHistory noise. The
        // dashboard can alert on this without alerting on every
        // rate-limited retry that eventually recovers.
        reportSilent(
          new Error('exercise_logs history fetch returned no rows after retry'),
          'workout:historyFetchEmpty',
        );
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

  // On-demand history fetch for a single lift — invoked when the user
  // swaps in an exercise that wasn't in the initial batch fetch.
  // Without this, the Coach's Call hero on the swapped-in lift would
  // stay suppressed as if it were cold-start, even for someone with
  // months of history on that exercise (COACH_CALL_FIX.md, B).
  //
  // Fire-and-forget by design — a failed single-lift fetch leaves the
  // hero in the same suppressed state it was in before (cold-start
  // fallback), and the user never sees an error surface.
  const fetchSingleLiftHistory = async (rawExName: string): Promise<void> => {
    try {
      if (!rawExName) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: logs, error } = await supabase
        .from('exercise_logs')
        .select('exercise_name, weight_kg, logged_date, reps_in_reserve, reps')
        .eq('user_id', user.id)
        .eq('is_recovery', false)
        .in('exercise_name', [rawExName])
        .order('logged_date', { ascending: false });
      if (error || !logs || logs.length === 0) return;

      const partialLatest: Record<string, { weight: number; date: string; rir: number | null; reps: number | null }> = {};
      const partialGrouped: Record<string, { weight_kg: number; date: string; rir: number | null }[]> = {};
      const partialTops: Record<string, Map<string, number>> = {};
      for (const row of logs as any[]) {
        const k = normalizeExName(row.exercise_name);
        if (!k) continue;
        if (!(k in partialLatest)) {
          partialLatest[k] = {
            weight: row.weight_kg,
            date: row.logged_date,
            rir: row.reps_in_reserve ?? null,
            reps: typeof row.reps === 'number' ? row.reps : null,
          };
        }
        if (!partialGrouped[k]) partialGrouped[k] = [];
        if (partialGrouped[k].length < 6) {
          partialGrouped[k].push({
            weight_kg: row.weight_kg,
            date: row.logged_date,
            rir: row.reps_in_reserve ?? null,
          });
        }
        const w = Number(row.weight_kg);
        if (Number.isFinite(w) && w > 0 && row.logged_date) {
          if (!partialTops[k]) partialTops[k] = new Map();
          const cur = partialTops[k].get(row.logged_date) ?? 0;
          if (w > cur) partialTops[k].set(row.logged_date, w);
        }
      }
      // MERGE into existing state — partial goes FIRST so any key
      // already in prev (populated by the initial batch fetch, which is
      // fresher) wins on collision. On the common path the swapped-in
      // key isn't in prev at all, so the merge is additive.
      setLastWeights(prev => ({ ...partialLatest, ...prev }));
      setExerciseHistory(prev => ({ ...partialGrouped, ...prev }));
      const partialTopsArr: Record<string, { topKg: number; date: string }[]> = {};
      for (const [name, m] of Object.entries(partialTops)) {
        partialTopsArr[name] = Array.from(m.entries())
          .map(([date, topKg]) => ({ date, topKg }))
          .sort((a, b) => a.date.localeCompare(b.date));
      }
      setLiftSessionTops(prev => ({ ...partialTopsArr, ...prev }));
    } catch (e) {
      reportSilent(e, 'workout:fetchSingleLiftHistory');
    }
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
      emphasis: selected.emphasis,
    };
    const newExercises = [...planDay.exercises];
    newExercises[swapTargetIndex] = swapped;
    setPlanDay({ ...planDay, exercises: newExercises });
    setSwapTargetIndex(null);
    setSwapModalVisible(false);
    // Durable echo: stick this swap across the rest of the block.
    void persistSwapToPlan(planDay.workoutType, swapOutName, selected);
    // If the swapped-in lift wasn't in the initial batch fetch, pull its
    // history on demand so the Coach's Call hero can render on it.
    if (!lastWeights[normalizeExName(selected.name)]) {
      void fetchSingleLiftHistory(selected.name);
    }
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
      emphasis: selected.emphasis,
    };
    setPlanDay({ ...planDay, exercises: [...planDay.exercises, appended] });
    setAddExerciseModalVisible(false);
    // Same on-demand fetch as the swap paths — an appended lift is
    // structurally the same "new name that wasn't in the batch fetch"
    // problem for the Coach's Call hero.
    if (!lastWeights[normalizeExName(selected.name)]) {
      void fetchSingleLiftHistory(selected.name);
    }
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
      emphasis: selected.emphasis,
    };
    const updated = [...workout];
    updated[exIndex] = swapped;
    setWorkout(updated);
    setSwapModalVisible(false);
    // Durable echo: stick this swap across the rest of the block.
    void persistSwapToPlan(planDay?.workoutType, swapOutName, selected);
    // On-demand history fetch — see fetchSingleLiftHistory + pre-screen
    // confirmPreScreenSwap for the paired call. Same rationale.
    if (!lastWeights[normalizeExName(selected.name)]) {
      void fetchSingleLiftHistory(selected.name);
    }
  };

  const currentEx = workout[exIndex];

  const handleNextExercise = () => {
    setShowMuscleDetails(false);
    setWeightPhaseForEx(exIndex);
    // Pre-fill with the prescription if we have one — that's the coach
    // actually doing the math. Falls back to last logged weight (which
    // includes an onboarding anchor seed, if one exists for this lift —
    // see src/lib/anchorSeed.ts). If NEITHER exists, fall back to a
    // same-session anchor-derived ESTIMATE (src/lib/anchorDerivation.ts) —
    // e.g. Incline Bench derived from the user's seeded Flat Bench. Only
    // when the lift isn't in the derivation map either (or its anchor was
    // never entered) does the box stay blank, matching the Coach's Call's
    // "first time on this — we'll find your weight as you go" line. This
    // replaces the removed bodyweight-derived guess, which contradicted
    // that line and produced nonsensical numbers for lifts the user hadn't
    // actually told us about — every number here traces back to something
    // the user typed, never a demographic average.
    const exName = workout[exIndex]?.name;
    const rx = exName ? prescriptions[exName] : undefined;
    const last = exName ? lastWeights[normalizeExName(exName)]?.weight : undefined;
    let seed: number | undefined = rx ? rx.suggestedWeightKg : last;
    if (seed === undefined && exName) {
      const derived = deriveFromAnchors({ exerciseName: exName, anchorWorkingWeights });
      if (derived != null) seed = derived;
    }
    setCurrentWeightInput(seed !== undefined ? String(seed) : '');

    // Reps prefill is gone with the reps-logging cut — no user input, so
    // there's nothing to seed. The RIR commit path computes the midpoint
    // from the plan's rep string at write time (see commitWithRir).

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
        cause: rx.cause,
        last_weight_kg: lastWeights[normalizeExName(exName)]?.weight ?? rx.suggestedWeightKg,
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
      // Reps AUTO-FILL — no user input; the value is the rounded midpoint
      // of the plan's rep range (see midpointFromReps). Written to
      // exercise_logs.reps for history / display; never read back into
      // prescribeLoad. Same sync-ref-then-state pattern as RIR so
      // finishWorkout on the last exercise reads the freshest value.
      const planReps = workout[weightPhaseForEx!]?.reps;
      const midpoint = midpointFromReps(planReps);
      if (typeof midpoint === 'number') {
        const next = { ...repsLogRef.current, [exName]: midpoint };
        repsLogRef.current = next;
        setRepsLog(next);
      } else {
        // Unparseable plan rep spec (e.g. "30-60s"): log null; no history
        // entry is better than a fabricated one.
        const next = { ...repsLogRef.current };
        delete next[exName];
        repsLogRef.current = next;
        setRepsLog(next);
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
    if (exName && repsLogRef.current[exName] !== undefined) {
      const next = { ...repsLogRef.current };
      delete next[exName];
      repsLogRef.current = next;
      setRepsLog(next);
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

  /**
   * Abandon = DISCARD + EXIT. NOT a completion path. The previous
   * implementation called finishWorkout() when any set had been logged,
   * which marked the session completed:true and persisted it — turning
   * the user's "I want out" into "this workout is done" (broken streak
   * vs. legitimately-not-trained day, spurious recap, etc.).
   *
   * Logs are only persisted by runFinishPersistence inside finishWorkout,
   * so abandon has no remote rollback to do — the entire discard is a
   * local in-memory clear of weightLogRef / rirLogRef and the mirrored
   * React state. The navigation step bypasses our own beforeRemove
   * listener via abandonBypassRef so the user isn't trapped in a loop
   * by their own confirm tap.
   */
  const confirmAbandon = () => {
    setShowAbandonModal(false);
    try {
      // Stop any in-flight rest timer — otherwise a late tick can call
      // setRestLeft after we've left the screen.
      clearRest();
      // Clear in-memory logs so a re-entry into the workout flow this
      // same JS session doesn't surface a stale prescription seeded
      // from this abandoned attempt.
      weightLogRef.current = {};
      rirLogRef.current = {};
      repsLogRef.current = {};
      setWeightLog({});
      setRirLog({});
      setRepsLog({});
    } catch (e) {
      reportSilent(e, 'workout:confirmAbandon:clear');
    }
    abandonBypassRef.current = true;
    try {
      router.replace('/(tabs)/home');
    } catch (e) {
      reportSilent(e, 'workout:confirmAbandon:navigate');
    }
  };

  // Intercept iOS swipe-back, header back, and any programmatic
  // navigation away while the workout is in progress (pre or active
  // phase). The 'complete' phase explicitly skips this so the user
  // can navigate back from their finished-session card normally.
  useEffect(() => {
    if (phase === 'complete') return;
    const sub = navigation.addListener('beforeRemove', (e: any) => {
      if (abandonBypassRef.current) return;
      try {
        e?.preventDefault?.();
      } catch (err) {
        reportSilent(err, 'workout:beforeRemove:preventDefault');
      }
      setShowAbandonModal(true);
    });
    return () => {
      try {
        sub();
      } catch (e) {
        reportSilent(e, 'workout:beforeRemove:cleanup');
      }
    };
  }, [navigation, phase]);

  // Android hardware back. When the modal is already open we let the
  // default fire so the modal closes itself via its onRequestClose
  // (matching the iOS swipe behavior on a dismissible sheet); otherwise
  // we open the modal and block the default pop.
  useEffect(() => {
    if (phase === 'complete') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (modalOpenRef.current) return false;
      setShowAbandonModal(true);
      return true;
    });
    return () => {
      try {
        sub.remove();
      } catch (e) {
        reportSilent(e, 'workout:backHandler:cleanup');
      }
    };
  }, [phase]);

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
          // Best-set reps. Null when the user cleared the prefilled target
          // and didn't type anything else — the top-of-band gate in
          // loadPrescription treats null as "no history to gate on."
          reps: repsLogRef.current[exerciseName] ?? null,
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

      // ── OPTIMISTIC PHASE TRANSITION ───────────────────────────────────
      // Everything the summary needs from in-memory state is now built
      // (workout, energyScore, weightLogRef ref reads happened above at
      // committedWeights). The remaining work — durable save, prior-log
      // fetch, PR detection, analytics, coach recap — feeds state that
      // the already-rendered summary re-reads on its own:
      //   • syncFailed → the "Couldn't sync" badge, set by the outer
      //     catch or the per-phase reportSilent path.
      //   • newPRs / prWeights → the PR celebration cards, set once
      //     computeSessionPrs settles.
      //   • prCheckPending → the "Checking for PRs…" placeholder,
      //     cleared alongside those PR writes.
      // Flipping phase here removes the 3–4s blank-screen delay the
      // user used to sit through while the network round-trips
      // finished; nothing here changes WHAT gets persisted, only WHEN
      // the UI flips.
      setPrCheckPending(true);
      setPhase('complete');
      Animated.parallel([
        Animated.spring(logoScale, { toValue: 1.2, friction: 4, tension: 5, useNativeDriver: true }),
        Animated.timing(logoGlow, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]).start();

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
            // Goal-aware target zone: strength (2-3), muscle (0-2), general (1-2).
            // Analytics event now reflects the lane, not a single universal window.
            hit_target_zone: hitTargetZone(rir, goal),
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
      let prMeta: { name: string; newWeightKg: number; prevBestKg: number }[] = [];
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
      // PR check has settled (either populated newPRs or ran a no-op
      // against zero logRows / a fetch error). Clear the "Checking for
      // PRs…" placeholder — from here on, the summary card shows
      // whatever PR cards exist, or nothing.
      setPrCheckPending(false);

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
            // navigates back to home). userName not threaded here — the
            // workout screen doesn't load username into state, and PR
            // observations are rare; the home focus rephrase picks them
            // up from cache with the name on next open if needed.
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
      // If we optimistically flipped to 'complete' before the throw, the
      // "Checking for PRs…" placeholder is still up. Clear it — the PR
      // pipeline crashed, and there's nothing else coming.
      setPrCheckPending(false);
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

    // NOTE. The phase→'complete' flip + logo animation moved UP inside
    // the try block, immediately after the synchronous save build. See
    // the "OPTIMISTIC PHASE TRANSITION" block. Everything below —
    // durable save, PR detection, analytics, coach recap — now runs
    // while the user is already looking at the summary card.
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
        // Ad-hoc "Train anyway" inherits the user's lane so the emergency
        // session is dosed identically to the planned one. Fall through to
        // catalog when we haven't finished loading the profile yet (rare —
        // the pre-workout screen usually mounts first).
        goal,
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
              fontSize: typography.size.s24,
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
              fontSize: typography.size.s15,
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
                  fontSize: typography.size.s11,
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
                      borderRadius: layout.radii.r12,
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
                        fontSize: typography.size.s14,
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
                  fontSize: typography.size.s11,
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
              // Suppress the pre-screen "Coach: {calibrating}" line when
              // the ACTIVE card's Coach's Call hero will carry the same
              // cold-start message for this lift. Product rule: a first-
              // timer should see exactly one cold-start message across
              // the flow. Bodyweight rows and lifts with history keep the
              // hint (the hero handles bodyweight by suppressing itself,
              // and history lifts get the real prescription line here).
              // Mirrors shouldShowCoachCall's cold-start branch:
              // non-bodyweight + rx null + lastKg falsy + historyLoad ready.
              const equipmentLc = (ex.equipment ?? '').toLowerCase().trim();
              const key = normalizeExName(ex.name);
              const rowRx = prescriptions[ex.name];
              const rowLastKg = lastWeights[key]?.weight;
              const heroWillCarryColdStart =
                equipmentLc !== 'bodyweight' &&
                rowRx == null &&
                (rowLastKg == null || rowLastKg <= 0) &&
                historyLoad === 'ready';
              const hint = heroWillCarryColdStart ? '' : (coachHints[ex.name] ?? '');
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
                        two lines clip the tail. Empty hint (cold-start
                        rows on the pre-screen) renders no line at all —
                        the hero on the active card is the single voice
                        for that path. */}
                    {hint ? (
                      <Text style={styles.sessionHint} numberOfLines={4}>
                        <Text style={{ color: colors.accentTeal }}>Coach: </Text>
                        {hint}
                      </Text>
                    ) : null}
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
                  borderRadius: layout.radii.r32,
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
                <Text style={{ fontFamily: typography.family.heading, fontSize: typography.size.s28, color: colors.accentTeal }}>L</Text>
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
                  borderRadius: layout.radii.r12,
                  borderWidth: 1,
                  borderColor: colors.accentAmber,
                  backgroundColor: colors.surface,
                }}
              >
                <Text
                  style={{
                    fontFamily: typography.family.bodyMedium,
                    fontSize: typography.size.s13,
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
                    fontSize: typography.size.s14,
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

            {/* PR celebration cards. While the prior-log fetch + detection
                are still resolving after the optimistic phase flip, we
                show a subtle inline placeholder instead of a blank spot —
                so the user has an honest cue that PR celebrations may
                still arrive a beat later. `newPRs.length > 0` supersedes
                the placeholder the moment detection lands with results;
                a truly PR-less session shows nothing (existing behaviour). */}
            {newPRs.length > 0 ? (
              <View style={{ marginTop: layout.spacing.md, gap: 8 }}>
                {newPRs.map(pr => {
                  // Committed logged weight — the exact number persisted to
                  // exercise_logs (snapshotted from logRows in Phase 5), not
                  // a weightLog lookup that can be stale or name-mismatched.
                  const newWeight = prWeights[pr] ?? NaN;
                  const prev = lastWeights[normalizeExName(pr)]?.weight;
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
            ) : prCheckPending ? (
              <View
                style={{
                  marginTop: layout.spacing.md,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: layout.spacing.xs,
                  paddingHorizontal: layout.spacing.md,
                }}
                accessibilityRole="progressbar"
                accessibilityLabel="Checking for personal records"
              >
                <ActivityIndicator
                  size="small"
                  color={colors.textMuted}
                />
                <Text
                  style={{
                    fontFamily: typography.family.body,
                    fontSize: typography.size.s12,
                    color: colors.textMuted,
                    letterSpacing: 0.4,
                  }}
                >
                  Checking for PRs…
                </Text>
              </View>
            ) : null}

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
                      <Text style={{ color: colors.accentTeal, fontSize: typography.size.s16 }}>✓</Text>
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
              <Text style={{ fontFamily: typography.family.body, fontSize: typography.size.s11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
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
        const lastEntry = lastWeights[normalizeExName(exName)];
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
                      fontSize: typography.size.s20,
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

                  {/* COACH'S CALL used to live here — it now renders on
                      the active exercise card BEFORE the set, where it can
                      actually inform the load instead of arriving after
                      the user already picked a weight. */}

                  {/* Reps prompt used to live here. Removed in the reps-
                      logging product cut: we no longer ask the user for
                      reps performed — the plan already prescribes a range,
                      so exercise_logs.reps is auto-populated with the
                      midpoint of that range at commit time (see
                      midpointFromReps + commitWithRir). The RIR chip below
                      is now the only post-set interaction. */}

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

      {/* Top bar: abandon button + progress bar */}
      <View style={styles.activeTopBar}>
        <TouchableOpacity
          onPress={() => setShowAbandonModal(true)}
          activeOpacity={0.6}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Abandon workout"
        >
          <Text style={[styles.abandonBtnText, { color: colors.textMuted }]}>✕</Text>
        </TouchableOpacity>
        <View style={[styles.progressBar, { backgroundColor: colors.surface }]}>
          <View style={[styles.progressFill, { width: `${progressPct * 100}%`, backgroundColor: colors.accentTeal }]} />
        </View>
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

      <ScrollView
        style={[styles.activeContainer, { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 }]}
        contentContainerStyle={{ justifyContent: 'space-between', flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Exercise image — STATIC by default (frame 0). The user taps
            the ▶ button overlaid on the photo to animate between the
            catalog's /0.jpg start and /1.jpg end frames, ⏸ to stop.
            Single-position lifts (only /0.jpg) hide the button. Falls
            back to a neutral name placeholder if 0.jpg is broken.
            resizeMode="contain" letterboxes the figure against the
            surfaceElevated background instead of cropping it. */}
        {currentEx.imageUrl && (() => {
          const frame0 = currentEx.imageUrl;
          const frame1 = secondFrameUrl(frame0);
          if (brokenImageUrls.has(frame0)) {
            return (
              <View
                style={[
                  styles.exerciseImageActive,
                  { backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' },
                ]}
              >
                <Text style={{ color: colors.textSecondary, fontSize: typography.size.s12 }}>
                  {currentEx.name}
                </Text>
              </View>
            );
          }
          const showSecond =
            !!frame1 &&
            !brokenImageUrls.has(frame1) &&
            frameLoopPlaying &&
            frameToggle;
          const uri = showSecond ? (frame1 as string) : frame0;
          return (
            <View style={styles.exerciseImageWrap}>
              <Image
                source={{ uri }}
                style={styles.exerciseImageActive}
                resizeMode="contain"
                onError={() => markImageBroken(uri)}
              />
              {hasSecondFrame ? (
                <TouchableOpacity
                  style={[
                    styles.exerciseImagePlayBtn,
                    { backgroundColor: colors.surface, borderColor: colors.cardBorder },
                  ]}
                  onPress={() => setFrameLoopPlaying(p => !p)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={
                    frameLoopPlaying ? 'Pause exercise demo' : 'Play exercise demo'
                  }
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text
                    style={[
                      styles.exerciseImagePlayGlyph,
                      { color: colors.textPrimary },
                      // The ▶ triangle has more weight on its left edge —
                      // nudge it 1px right so it reads optically centered
                      // inside the circle. ⏸ is symmetric, no nudge.
                      !frameLoopPlaying && { marginLeft: 2 },
                    ]}
                  >
                    {frameLoopPlaying ? '⏸' : '▶'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })()}

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
          const last = lastWeights[normalizeExName(currentEx.name)];
          if (!last || !last.weight) return null;
          const ago = formatLastUsedAgo(last.date);
          return (
            <Text style={[styles.activeExLastUsed, { color: colors.textMuted }]} numberOfLines={1}>
              Last: <Text style={{ color: colors.textSecondary }}>{last.weight} kg</Text>
              {ago ? ` · ${ago}` : ''}
            </Text>
          );
        })()}

        {/* COACH'S CALL — the prescription hero, surfaced on the active
            exercise card BEFORE the user starts the set. Previously this
            lived in the post-set weight popup, but it was telling the
            user what to load AFTER they'd already loaded the bar. The
            popup now just captures the RIR; the headline (kg + delta +
            cause) lives here, where it can actually inform the load. */}
        {(() => {
          const exName = currentEx.name;
          const key = normalizeExName(exName);
          const lastKg = lastWeights[key]?.weight;
          const rx = prescriptions[exName];
          // Render guard for the Coach's Call hero — extracted to
          // src/lib/coachCall.ts so the decision table is unit-tested.
          // `historyLoad` matters here: the product wants the hero on
          // first-time exercises too (cold-start branch), but ONLY once
          // we're sure the user is a cold-starter. While the initial
          // exercise_logs fetch is still 'loading' or 'error', we
          // suppress — otherwise a cold message would flash and get
          // replaced the moment history lands.
          if (!shouldShowCoachCall({
            equipment: currentEx.equipment,
            rx,
            lastKg,
            historyLoad,
          })) return null;
          // "Based on your 100×5" attribution — ONLY while the onboarding
          // seed is still this lift's entire history. exerciseHistory[key]
          // is the last-6-DESC log list from the same fetch that built
          // lastWeights; a single entry whose date matches the cached
          // seed's logged_date means no real session has been logged for
          // this lift yet. The moment session one is logged, a second
          // entry appears and this collapses to undefined — "one line, at
          // that moment only," per spec.
          const seedNote = anchorSeedNotes[key];
          const historyForLift = exerciseHistory[key];
          const anchorSeed =
            seedNote && historyForLift?.length === 1 && historyForLift[0].date === seedNote.loggedDate
              ? { weightKg: seedNote.enteredWeightKg, reps: seedNote.enteredReps }
              : null;
          // Anchor-derived ESTIMATE — only relevant on the true cold-start
          // path (no rx, no lastKg): a DIFFERENT lift than any anchor, but
          // one src/lib/anchorDerivation.ts can estimate from what the
          // user told us about a related anchor lift. Mutually exclusive
          // with anchorSeed above (that's for the anchor exercise ITSELF;
          // deriveFromAnchors excludes the five anchor exercises from its
          // map, so it naturally returns null for them). null whenever the
          // anchor is missing/unlogged or the exercise isn't in the map —
          // the hero then falls back to the bare calibration line.
          const derivedEstimate = (!rx && !lastKg)
            ? (() => {
                const weightKg = deriveFromAnchors({ exerciseName: exName, anchorWorkingWeights });
                if (weightKg == null) return null;
                const basis = basisForExercise(exName);
                if (!basis) return null;
                return { weightKg, basisLabel: ANCHOR_BASIS_LABEL[basis] };
              })()
            : null;
          const hero = buildPrescriptionHero({
            rx,
            lastWeightKg: lastKg,
            hasLastRir: lastWeights[key]?.rir != null,
            // Energy modulates the hold/low_energy branches. The
            // presenter weaves the kg into the reason directly, so the
            // single sentence here replaces both the old separate
            // "Coach:" line (energy framing + rep directive) and the
            // micro-line (energy banner). The active card now renders
            // ONE coach block, not three.
            energyScore,
            anchorSeed,
            derivedEstimate,
          });
          const accent =
            hero.tone === 'progress' ? colors.accentTeal :
            hero.tone === 'backoff'  ? colors.accentCoral :
            colors.textSecondary;
          return (
            <View
              style={[styles.prescriptionHero, { borderLeftColor: accent }]}
              accessibilityRole="text"
              accessibilityLabel={
                hero.weightLabel
                  ? `Coach's call: ${hero.weightLabel}, ${hero.deltaLabel}. ${hero.reason}`
                  : `Coach's call: ${hero.reason}`
              }
            >
              <Text style={[styles.prescriptionHeroKicker, { color: accent }]}>
                COACH'S CALL
              </Text>
              {hero.weightLabel ? (
                <View style={styles.prescriptionHeroRow}>
                  <Text style={[styles.prescriptionHeroWeight, { color: colors.textPrimary }]}>
                    {hero.weightLabel}
                  </Text>
                  <Text style={[styles.prescriptionHeroDelta, { color: accent }]}>
                    {hero.deltaLabel}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.prescriptionHeroReason, { color: colors.textSecondary }]}>
                {hero.reason}
              </Text>
            </View>
          );
        })()}

        {/* The COACH'S CALL hero above is the ONLY coach voice on the
            active card. Energy framing and the rep directive used to
            live in a separate "Coach:" line (coachLineForPrescription)
            and a micro-line; both are now folded into the hero's single
            reason sentence via buildPrescriptionHero({ energyScore }).
            coachHints is still computed for the pre-screen exercise list
            but is intentionally NOT rendered here — one block, one
            voice, no contradictions between sentences. */}

        {/* Muscle group label */}
        <Text style={[styles.muscleTag, { color: colors.textMuted }]}>{currentEx.primaryMuscle.toUpperCase()}</Text>

        {getMuscleInfo(currentEx.primaryMuscle) && (
          <TouchableOpacity
            style={[styles.detailsBtn, { borderColor: colors.cardBorder }]}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setShowMuscleDetails(v => !v);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.detailsBtnText, { color: colors.accentTeal }]}>
              {showMuscleDetails ? 'Hide details' : 'Details'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Expandable muscle details card */}
        {showMuscleDetails && getMuscleInfo(currentEx.primaryMuscle) && (
          <View style={[styles.muscleDetailsCard, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
            <MuscleDetails
              muscle={currentEx.primaryMuscle}
              emphasis={currentEx.emphasis}
            />
          </View>
        )}

        <View style={{ flex: 1 }} />

        {/* NEXT EXERCISE — full width */}
        <TouchableOpacity
          style={[styles.nextExBtn, { backgroundColor: colors.accentTeal }]}
          onPress={handleNextExercise}
          activeOpacity={0.8}
        >
          <Text style={styles.nextExBtnText}>NEXT EXERCISE</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Abandon confirmation modal. Copy and labels come from
          src/lib/workoutAbandon so the tested promise ("won't be saved")
          can't drift from what the screen actually shows. */}
      {(() => {
        const copy = abandonModalCopy({
          hasLoggedSets: Object.keys(weightLogRef.current).length > 0,
        });
        return (
          <Modal
            visible={showAbandonModal}
            transparent
            animationType="fade"
            onRequestClose={() => setShowAbandonModal(false)}
          >
            <View style={styles.abandonOverlay}>
              <View style={[styles.abandonCard, { backgroundColor: colors.surface }]}>
                <Text style={[styles.abandonTitle, { color: colors.textPrimary }]}>
                  {copy.title}
                </Text>
                <Text style={[styles.abandonBody, { color: colors.textSecondary }]}>
                  {copy.body}
                </Text>
                <View style={styles.abandonActions}>
                  <TouchableOpacity
                    style={[styles.abandonCancelBtn, { borderColor: colors.cardBorder }]}
                    onPress={() => setShowAbandonModal(false)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.abandonCancelText, { color: colors.textPrimary }]}>
                      {copy.cancelLabel}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.abandonConfirmBtn, { backgroundColor: colors.accentRed }]}
                    onPress={confirmAbandon}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.abandonConfirmText}>{copy.confirmLabel}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        );
      })()}
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
      fontSize: typography.size.s12,
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
      fontSize: typography.size.s11,
      letterSpacing: 1.6,
      marginBottom: 6,
    },
    readinessBody: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      lineHeight: 20,
      letterSpacing: 0.1,
    },
    coachBannerTitle: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s11,
      letterSpacing: 2,
      marginBottom: 6,
    },
    coachBannerBody: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s13,
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
      fontSize: typography.size.s11,
      letterSpacing: 0.5,
    },
    sessionHeader: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s11,
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
      fontSize: typography.size.s14,
      letterSpacing: -0.2,
      color: colors.textPrimary,
    },
    sessionExSetsReps: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      color: colors.textSecondary,
      fontVariant: ['tabular-nums'],
    },
    sessionHint: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11_5,
      color: colors.textMuted,
      lineHeight: 16,
    },
    // Per-exercise hint shown during the active set. Same sizing as
    // sessionHint but with top margin for the centered active layout and
    // a slightly brighter base color since it lives on the dark surface.
    activeCoachHint: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      lineHeight: 17,
      marginTop: 6,
      textAlign: 'center',
      paddingHorizontal: layout.spacing.md,
    },
    swapIconBtn: {
      width: 36,
      height: 36,
      borderRadius: layout.radii.r18,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swapIconText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s16,
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
      fontSize: typography.size.s11,
      color: colors.textMuted,
      textTransform: 'uppercase',
      marginTop: 4,
    },
    energySectionLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s11,
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
      borderRadius: layout.radii.r2,
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
    // Energy selector
    energyRow: {
      flexDirection: 'row',
      gap: 10,
      marginTop: layout.spacing.sm,
    },
    energyBox: {
      width: 48,
      height: 48,
      borderRadius: layout.radii.r2,
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
      fontSize: typography.size.s10,
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
      fontSize: typography.size.s12,
      color: colors.accentTeal,
    },
    coachCtaText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s11,
      letterSpacing: 1.5,
      color: colors.accentTeal,
    },
    replannedBadge: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s10,
      letterSpacing: 2,
      color: colors.accentTeal,
      marginTop: layout.spacing.lg,
    },
    replanOverlay: {
      flex: 1,
      backgroundColor: colors.scrimHeavy,
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
      fontSize: typography.size.s10,
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
      fontSize: typography.size.s13_5,
      color: colors.textPrimary,
      lineHeight: 20,
    },
    replanUsage: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s10_5,
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
      fontSize: typography.size.s13,
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
      backgroundColor: colors.scrimMedium,
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
      borderRadius: layout.radii.r2,
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
      borderRadius: layout.radii.r1_5,
      marginHorizontal: 0,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: layout.radii.r1_5,
    },
    activeTopBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: layout.spacing.lg,
      paddingTop: layout.spacing.sm,
      gap: 12,
    },
    abandonBtnText: {
      fontSize: typography.size.s18,
      fontWeight: '600',
    },
    abandonOverlay: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: colors.scrimMedium,
      paddingHorizontal: 40,
    },
    abandonCard: {
      borderRadius: layout.cardRadius,
      padding: 24,
      width: '100%',
    },
    abandonTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.md,
      marginBottom: 8,
    },
    abandonBody: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      lineHeight: 20,
      marginBottom: 20,
    },
    abandonActions: {
      flexDirection: 'row',
      gap: 12,
    },
    abandonCancelBtn: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: layout.pillRadius,
      borderWidth: 1,
      alignItems: 'center',
    },
    abandonCancelText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
    },
    abandonConfirmBtn: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: layout.pillRadius,
      alignItems: 'center',
    },
    abandonConfirmText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
      color: colors.textPrimary,
    },
    activeContainer: {
      flex: 1,
      paddingTop: layout.spacing.lg,
    },
    exerciseImageWrap: {
      position: 'relative',
      marginBottom: layout.spacing.md,
    },
    exerciseImageActive: {
      width: '100%',
      height: 240,
      borderRadius: layout.radii.r2,
      backgroundColor: colors.surfaceElevated,
    },
    exerciseImagePlayBtn: {
      position: 'absolute',
      right: 10,
      bottom: 10,
      width: 36,
      height: 36,
      borderRadius: layout.radii.r18,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      // Subtle lift so the button reads as floating over the photo
      // regardless of which underlying frame the image is on.
      shadowColor: colors.shadowColor,
      ...elevation.button,
    },
    exerciseImagePlayGlyph: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s14,
    },
    activeExName: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s24,
      color: colors.textPrimary,
      marginBottom: 4,
    },
    activeExSetsReps: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      color: colors.textSecondary,
      marginBottom: 2,
    },
    activeExLastUsed: {
      // Pre-set historical reference. Mid-weight (textMuted prefix, textSecondary
      // emphasis on the number) so it reads as data, not a coach prompt.
      fontFamily: typography.family.body,
      fontSize: typography.size.s13,
      lineHeight: 18,
      marginBottom: 6,
      letterSpacing: 0.1,
    },
    muscleTag: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      color: colors.textMuted,
      textTransform: 'uppercase',
    },
    detailsBtn: {
      alignSelf: 'flex-start',
      marginTop: 10,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: layout.smRadius,
      borderWidth: 1,
      backgroundColor: colors.surface,
    },
    detailsBtnText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s12,
      letterSpacing: 0.2,
    },
    muscleDetailsCard: {
      marginTop: layout.spacing.md,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      overflow: 'hidden',
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
      borderRadius: layout.radii.r20,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    activeSwapIconGlyph: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s18,
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
      fontSize: typography.size.s13,
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
      fontSize: typography.size.s11,
      letterSpacing: 2,
      color: colors.textMuted,
    },
    restTimerCount: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s20,
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
      fontSize: typography.size.s12,
      color: colors.textSecondary,
    },
    // ── Centered rest-timer overlay ─────────────────────────────────
    restTimerOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.scrimMedium,
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
      fontSize: typography.size.s12,
      letterSpacing: 3,
      color: colors.textMuted,
      marginBottom: layout.spacing.sm,
    },
    restTimerCountBig: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s64,
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
      fontSize: typography.size.s14,
      color: colors.textSecondary,
      letterSpacing: 0.5,
    },
    weightOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.scrimSoft,
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
      fontSize: typography.size.s12,
      textTransform: 'uppercase',
      marginBottom: layout.spacing.md,
    },
    weightLabel: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s10,
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
      fontSize: typography.size.s11,
      color: colors.textMuted,
      letterSpacing: 0.5,
    },
    // ── Redesigned RIR commit block ─────────────────────────────────────
    // Sized so the chips are the visual anchor of the weight phase, not a
    // footer afterthought. One tap on a chip logs the set with that RIR.
    rirHeader: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s18,
      letterSpacing: 0.2,
      marginBottom: 4,
      textAlign: 'left',
    },
    rirHelper: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
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
    // (Reps stepper styles removed with the reps-logging cut; midpoint
    // auto-fill happens in commitWithRir without any UI.)
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
      fontSize: typography.size.s13,
      letterSpacing: 0.2,
      marginBottom: 2,
      textAlign: 'center',
    },
    rirChipBigSub: {
      fontFamily: typography.family.body,
      // 10px sub stays clearly subordinate to the 13px label — the size
      // gap is what reads "secondary" in addition to the muted color.
      fontSize: typography.size.s10,
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
      fontSize: typography.size.s12,
      letterSpacing: 0.2,
      paddingVertical: 6,
    },
    rirSecondaryDivider: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      opacity: 0.6,
    },
    prescriptionNote: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s12,
      letterSpacing: 0.3,
      marginTop: -layout.spacing.sm,
      marginBottom: layout.spacing.sm,
    },
    prescriptionHero: {
      marginBottom: layout.spacing.md,
      paddingVertical: layout.spacing.sm,
      paddingHorizontal: layout.spacing.md,
      borderLeftWidth: 3,
      backgroundColor: colors.surface,
      borderRadius: layout.smRadius,
    },
    prescriptionHeroKicker: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s10,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginBottom: 6,
    },
    prescriptionHeroRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 10,
      marginBottom: 4,
    },
    prescriptionHeroWeight: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s24,
      letterSpacing: -0.4,
    },
    prescriptionHeroDelta: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s12,
      letterSpacing: 0.3,
    },
    prescriptionHeroReason: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s13,
      lineHeight: 18,
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
      fontSize: typography.size.s11,
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
      fontSize: typography.size.s20,
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
      fontSize: typography.size.s12,
      letterSpacing: 1,
    },
    weightSkipText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
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
      borderRadius: layout.radii.r60,
      backgroundColor: colors.accentAmber + '22',
    },
    prLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s9_5,
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
      fontSize: typography.size.s19,
      letterSpacing: -0.4,
      color: colors.textPrimary,
      flex: 1,
    },
    prWeight: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s22,
      letterSpacing: -0.5,
      color: colors.textPrimary,
    },
    prWeightUnit: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      color: colors.textSecondary,
    },
    prDelta: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s10_5,
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
      borderRadius: layout.radii.r12,
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