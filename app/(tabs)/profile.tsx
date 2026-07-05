import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  LayoutAnimation,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  UIManager,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import Button from '../../src/components/Button';
import { useTheme } from '../../src/context/ThemeContext';
import { supabase } from '../../src/lib/supabase';
import { reportSilent } from '../../src/lib/errorReporting';
import { layout, typography } from '../../src/theme';
import { cancelAllNotifications, getSavedNotifTime, NOTIF_TIME_KEY, NotifTime, requestNotificationPermission, saveNotifTime, scheduleWorkoutNotifications } from '../../src/utils/notifications';
import { ensureCurrentWeekPlan, writeCachedProfileInputs } from '../../src/lib/planSync';
import { splitForDays, type SplitId } from '../../src/lib/planGeneration';
import { hasConsecutiveRun, normalizeTrainingWeekdays } from '../../src/utils/trainingWeekdays';
import { BUILD_TAG } from '../../src/constants/buildInfo';
import { performDeleteAccount } from '../../src/lib/deleteAccount';
import { useEntitlement } from '../../src/lib/purchases';

// Enable LayoutAnimation on Android — needed for the collapsible settings.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// --- Helpers ---
const sanitizeLabel = (str: string | null | undefined): string => {
  if (!str) return '—';
  return str
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

// Live legal pages (GitHub Pages). Opened in an in-app browser tab via
// expo-web-browser. Play also requires the deletion page to be reachable
// from a public URL — that lives on the same site (account-deletion.html).
const PRIVACY_URL = 'https://labidi0omar.github.io/intr/privacy-policy.html';
const TERMS_URL = 'https://labidi0omar.github.io/intr/terms-of-use.html';

const PR_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const formatPrDate = (iso: string): string => {
  // logged_date is YYYY-MM-DD; parse as local to avoid TZ drift.
  const parts = iso.split('-').map(Number);
  if (parts.length < 3) return iso;
  const [y, m, d] = parts;
  return `${PR_MONTHS[m - 1] ?? ''} ${String(d).padStart(2, '0')}`;
};


// --- Types ---
type Profile = {
  id: string;
  username: string;
  goal: string;
  fitness_level: string;
  preferred_split: string;
  training_days: number;
  /** User's chosen calendar weekdays (0=Sun..6=Sat). Null = no explicit
   *  pick (legacy / 1-2-7-day users); the generator falls back to
   *  pickDefaultDayOffsets in that case. */
  training_weekdays: number[] | null;
  created_at: string;
};

type ProgressLog = {
  id: string;
  weight_kg: number;
  logged_date: string;
};

type RecordPR = {
  exercise_name: string;
  weight_kg: number;
  logged_date: string;
};

type ModalType = 'none' | 'weight' | 'name' | 'goal' | 'fitness_level' | 'split' | 'notifications' | 'training_days' | 'location';

// Closed set enforced by the profiles_goal_check CHECK constraint. The
// previous vocabulary (build_muscle / lose_weight / improve_endurance /
// general_fitness) was already split-brain against the DB constraint and
// silently failed on save; unified here so onboarding + Profile write the
// same three values the migration backfilled the legacy rows to.
const GOAL_OPTIONS: { value: 'strength' | 'muscle' | 'general'; label: string }[] = [
  { value: 'strength', label: 'Strength' },
  { value: 'muscle', label: 'Build Muscle' },
  { value: 'general', label: 'General Fitness' },
];
const FITNESS_LEVEL_OPTIONS = ['beginner', 'intermediate', 'advanced'];
const TRAINING_DAYS_OPTIONS = [2, 3, 4, 5, 6];
// Weekday picker layout — Mon..Sun, values are JS Date.getDay() indices.
const WEEKDAY_LAYOUT: { value: number; label: string }[] = [
  { value: 1, label: 'M' },
  { value: 2, label: 'T' },
  { value: 3, label: 'W' },
  { value: 4, label: 'T' },
  { value: 5, label: 'F' },
  { value: 6, label: 'S' },
  { value: 0, label: 'S' },
];
const MIN_WEEKDAYS_PICK = 3;
const MAX_WEEKDAYS_PICK = 6;
const LOCATION_OPTIONS: { value: 'Gym' | 'Home'; label: string }[] = [
  { value: 'Gym', label: 'Gym' },
  { value: 'Home', label: 'Home' },
];
const SPLIT_OPTIONS = [
  { id: 'full_body', title: 'Starter', desc: 'Train everything, 3 days, perfect for getting started' },
  { id: 'upper_lower', title: 'Upper / Lower', desc: '4 days, classic strength split' },
  { id: 'ppl', title: 'Push / Pull / Legs', desc: '5-6 days, serious gains' },
  { id: 'bro_split', title: 'Bro Split', desc: '5 days, chest/triceps, back/biceps, legs, shoulders, arms' }
];

// --- Skeleton ---
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
  return <Animated.View style={[{ width, height, backgroundColor: colors.textSecondary + '40', borderRadius, opacity }, style]} />;
};

export default function ProfileScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [weightLogs, setWeightLogs] = useState<ProgressLog[]>([]);
  const [topPRs, setTopPRs] = useState<RecordPR[]>([]);
  const [lifetimeMoved, setLifetimeMoved] = useState<number>(0);
  const [daysSinceSignup, setDaysSinceSignup] = useState<number>(0);

  // Modal State
  const [modalType, setModalType] = useState<ModalType>('none');
  const [inputValue, setInputValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // ── Delete-account confirmation ───────────────────────────────────────
  // Separate from the settings modal because the interaction model is
  // different (typed-confirm gate, destructive treatment, irreversible).
  // No state-machine sharing with the settings modal so a stray
  // setModalType('none') can't accidentally tear down a half-completed
  // delete confirmation.
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { isPro: hasActiveSubscription } = useEntitlement();
  const [successMsg, setSuccessMsg] = useState('');
  const [notifTime, setNotifTime] = useState<NotifTime | null>(null);
  const [notifHourInput, setNotifHourInput] = useState('7');
  const [notifMinuteInput, setNotifMinuteInput] = useState('00');
  const [notifAMPM, setNotifAMPM] = useState<'AM' | 'PM'>('AM');
  const [defaultLocation, setDefaultLocation] = useState<'Gym' | 'Home'>('Gym');
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  // Transient state for the weekday picker modal. Initialized on openModal
  // from profile.training_weekdays so toggling can be cancelled by closing
  // the sheet without saving. The picker is the source of truth for the
  // day count — count is derived on save.
  const [editingWeekdays, setEditingWeekdays] = useState<number[]>([]);

  const toggleSettings = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSettingsExpanded(s => !s);
  };

  useEffect(() => {
    fetchProfileData();
  }, []);

  const fetchProfileData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [profRes, logsRes, exerciseLogsRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', user.id).single(),
        supabase.from('progress_logs').select('*').eq('user_id', user.id).order('logged_date', { ascending: true }),
        // EXCLUSION BOUNDARY: weight history graph. Recovery rows carry
        // light prehab weights that would deform the trend. See src/lib/recovery.ts.
        supabase.from('exercise_logs').select('exercise_name, weight_kg, logged_date').eq('user_id', user.id).eq('is_recovery', false),
      ]);

      if (profRes.data) {
        setProfile(profRes.data as Profile);
        if (profRes.data.created_at) {
          const created = new Date(profRes.data.created_at).getTime();
          const days = Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)));
          setDaysSinceSignup(days);
        }
      }
      if (logsRes.data) setWeightLogs(logsRes.data as ProgressLog[]);

      // Records — top 3 PRs by max weight, plus lifetime "moved" (sum of all logged weights)
      if (exerciseLogsRes.data) {
        const rows = exerciseLogsRes.data as { exercise_name: string; weight_kg: number; logged_date: string }[];
        const maxByEx: Record<string, RecordPR> = {};
        let moved = 0;
        for (const row of rows) {
          moved += row.weight_kg;
          const cur = maxByEx[row.exercise_name];
          if (!cur || row.weight_kg > cur.weight_kg) {
            maxByEx[row.exercise_name] = { exercise_name: row.exercise_name, weight_kg: row.weight_kg, logged_date: row.logged_date };
          }
        }
        const sorted = Object.values(maxByEx).sort((a, b) => b.weight_kg - a.weight_kg).slice(0, 3);
        setTopPRs(sorted);
        setLifetimeMoved(Math.round(moved));
      }

      const storedLoc = await AsyncStorage.getItem('user:defaultLocation');
      if (storedLoc === 'Gym' || storedLoc === 'Home') setDefaultLocation(storedLoc);

      const savedTime = await getSavedNotifTime();
      if (savedTime) {
        setNotifTime(savedTime);
        const isPM = savedTime.hour >= 12;
        const displayHour = savedTime.hour % 12 === 0 ? 12 : savedTime.hour % 12;
        setNotifHourInput(displayHour.toString());
        setNotifMinuteInput(String(savedTime.minute).padStart(2, '0'));
        setNotifAMPM(isPM ? 'PM' : 'AM');
      }
    } catch (e) {
      reportSilent(e, 'profile:loadProfile');
    } finally {
      setLoading(false);
    }
  };

  const currentWeight = weightLogs.length > 0 ? weightLogs[weightLogs.length - 1].weight_kg : null;
  const initial = profile?.username ? profile.username.charAt(0).toUpperCase() : '?';

  const handleShare = async () => {
    try {
      await Share.share({
        message: "I've been training with Intr — check it out! 🏋️‍♀️",
      });
    } catch (e) {
      // share cancelled
      reportSilent(e, 'profile:share');
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/welcome');
  };

  // Open a legal page in an in-app browser tab. Wrapped per the codebase
  // error-reporting convention — a browser failure must never crash Profile.
  const openLegal = async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch (e) {
      reportSilent(e, 'profile:openLegal');
    }
  };

  /**
   * Confirmed delete-account handler. Wired to the "Delete account" button
   * inside the typed-confirm modal — it ONLY fires when the user has typed
   * the literal word "DELETE" (case-sensitive) in the confirm field.
   *
   * On success: performDeleteAccount has already signed out + cleared
   * AsyncStorage. We just route to /welcome and tear down the modal.
   *
   * On failure: we leave the user signed in and show the server's error
   * inline. They can retry or cancel out.
   */
  const handleConfirmDelete = async () => {
    if (deleteConfirmText !== 'DELETE') return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const result = await performDeleteAccount();
      if (result.ok) {
        // Tear down all delete-modal state before navigating so a fast
        // back-nav can't briefly flash it on the way out.
        setShowDeleteModal(false);
        setDeleteConfirmText('');
        setIsDeleting(false);
        router.replace('/welcome');
        return;
      }
      setDeleteError(result.error);
    } catch (e) {
      // performDeleteAccount is non-throwing, but belt-and-braces.
      reportSilent(e, 'profile:handleConfirmDelete');
      setDeleteError('Something went wrong. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const openDeleteModal = () => {
    setDeleteConfirmText('');
    setDeleteError(null);
    setShowDeleteModal(true);
  };
  const closeDeleteModal = () => {
    if (isDeleting) return; // can't close mid-delete
    setShowDeleteModal(false);
    setDeleteConfirmText('');
    setDeleteError(null);
  };

  const openModal = (type: ModalType) => {
    setInputValue('');
    setSuccessMsg('');
    if (type === 'name') setInputValue(profile?.username || '');
    if (type === 'weight' && currentWeight) setInputValue(currentWeight.toString());
    if (type === 'training_days') {
      // Seed the picker from the profile. Fall back to a Mon/Wed/Fri-style
      // default when the user is a legacy/out-of-scope account (null
      // weekdays); the user can adjust before saving. The cap of
      // MAX_WEEKDAYS_PICK is enforced on save, not on seed — an existing
      // 7-day user opening the modal sees their 7 days and can keep them
      // (we only refuse to PUSH past the cap on toggle).
      const seeded = normalizeTrainingWeekdays(profile?.training_weekdays);
      setEditingWeekdays(seeded ?? [1, 3, 5]);
    }
    setModalType(type);
  };

  // Toggle a weekday in the picker. Cap-aware: a tap that would push the
  // selection past MAX_WEEKDAYS_PICK is dropped (UI also disables the chip).
  const toggleEditingWeekday = (w: number) => {
    setEditingWeekdays(prev => {
      if (prev.includes(w)) return prev.filter(x => x !== w);
      if (prev.length >= MAX_WEEKDAYS_PICK) return prev;
      return [...prev, w].sort((a, b) => a - b);
    });
  };

  // Save the weekday picker. Persists training_weekdays + the derived
  // training_days count; runs the split-mismatch guardrail (split may
  // change atomically with the day count); rebuilds the plan.
  const saveWeekdaysEdit = async () => {
    if (editingWeekdays.length < MIN_WEEKDAYS_PICK || editingWeekdays.length > MAX_WEEKDAYS_PICK) return;
    try {
      setIsSaving(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !profile) return;

      const n = editingWeekdays.length;
      const currentSplit = (profile.preferred_split ?? 'ppl') as SplitId;
      const finalSplit = await askSplitMismatch(n, currentSplit);
      const updateParams: { training_days: number; training_weekdays: number[]; preferred_split?: SplitId } = {
        training_days: n,
        training_weekdays: editingWeekdays,
      };
      if (finalSplit !== currentSplit) updateParams.preferred_split = finalSplit;

      const { error } = await supabase.from('profiles').update(updateParams).eq('id', user.id);
      if (error) {
        reportSilent(error, 'profile:saveWeekdays');
        setSuccessMsg(`Save failed: ${error.message}`);
        setTimeout(() => setSuccessMsg(''), 6000);
        return;
      }

      setProfile({
        ...profile,
        training_days: n,
        training_weekdays: editingWeekdays,
        ...(updateParams.preferred_split ? { preferred_split: updateParams.preferred_split } : {}),
      });
      await writeCachedProfileInputs({
        training_days: n,
        training_weekdays: editingWeekdays,
        ...(updateParams.preferred_split ? { preferred_split: updateParams.preferred_split } : {}),
      });
      await ensureCurrentWeekPlan({ force: true });
      setSuccessMsg('Plan rebuilt for your new schedule');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (e) {
      reportSilent(e, 'profile:saveWeekdays');
    } finally {
      setIsSaving(false);
      setModalType('none');
    }
  };

  // Soft guardrail used by both the split-edit and training-days-edit paths.
  // When the user's days/split combo doesn't match splitForDays(days), prompt
  // them to switch to the recommended split. Resolves with whichever split
  // the user picked — the caller persists it. No-op (resolves immediately
  // with `picked`) when the combo already matches. Android back-dismiss
  // counts as "keep my choice" so the user is never trapped.
  const askSplitMismatch = (days: number, picked: SplitId): Promise<SplitId> => {
    return new Promise<SplitId>(resolve => {
      const recommended = splitForDays(days);
      if (picked === recommended) {
        resolve(picked);
        return;
      }
      const labelFor = (id: SplitId): string => {
        switch (id) {
          case 'full_body': return 'Full Body';
          case 'upper_lower': return 'Upper / Lower';
          case 'ppl': return 'Push / Pull / Legs';
          case 'bro_split': return 'Bro Split';
        }
      };
      Alert.alert(
        'Quick check',
        `For ${days} days a week, ${labelFor(recommended)} trains every muscle group more evenly than ${labelFor(picked)}. Use ${labelFor(recommended)}?`,
        [
          { text: `Use ${labelFor(recommended)}`, onPress: () => resolve(recommended) },
          { text: 'Keep my choice', style: 'cancel', onPress: () => resolve(picked) },
        ],
        { onDismiss: () => resolve(picked) },
      );
    });
  };

  const handleSaveModal = async (forcedValue?: string) => {
    try {
      setIsSaving(true);
      const val = forcedValue !== undefined ? forcedValue : inputValue;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      if (modalType === 'name' || modalType === 'goal' || modalType === 'fitness_level' || modalType === 'split') {
        const updateParams: any = {};
        if (modalType === 'name') updateParams.username = val;
        if (modalType === 'goal') updateParams.goal = val;
        if (modalType === 'fitness_level') updateParams.fitness_level = val;

        // Split edit: same soft guardrail as onboarding. If the picked split
        // doesn't match splitForDays(training_days), prompt the user. Their
        // answer drives what we persist. Asked through an Alert so the dialog
        // works on both iOS and Android without a custom modal.
        if (modalType === 'split') {
          const finalSplit = profile?.training_days
            ? await askSplitMismatch(profile.training_days, val as SplitId)
            : (val as SplitId);
          updateParams.preferred_split = finalSplit;
        }

        const { error } = await supabase.from('profiles').update(updateParams).eq('id', user.id);
        if (error) {
          console.error('[profile update]', error);
          // Surface the actual error so silent failures stop wasting time.
          setSuccessMsg(`Save failed: ${error.message}`);
          setTimeout(() => setSuccessMsg(''), 6000);
          return;
        }
        if (profile) {
          setProfile({ ...profile, ...updateParams });

          if (modalType === 'split') {
            setTimeout(() => setSuccessMsg('Split updated'), 300);
            setTimeout(() => setSuccessMsg(''), 4000);
          }
        }

        // Mirror plan-shaping edits into the offline cache so regen/self-heal
        // keep working without a network read. Location lives in its own key
        // (user:defaultLocation); only split/level belong to this blob.
        // Fire-and-forget.
        if (modalType === 'split') writeCachedProfileInputs({ preferred_split: updateParams.preferred_split });
        if (modalType === 'fitness_level') writeCachedProfileInputs({ fitness_level: val });
        // Goal drives generatePlan's per-exercise dose (goalProfile lane) —
        // an offline regen after this edit needs the cache to reflect the
        // change or the next self-heal would deviate. Follow with a
        // force-regen so future rows pick up the new lane immediately;
        // otherwise they'd carry the old dose until the block boundary.
        if (modalType === 'goal') {
          await writeCachedProfileInputs({ goal: val });
          await ensureCurrentWeekPlan({ force: true });
          setSuccessMsg('Plan rebuilt for your new goal');
          setTimeout(() => setSuccessMsg(''), 4000);
        }
      } else if (modalType === 'weight') {
        const kg = parseFloat(val);
        if (!isNaN(kg)) {
          const { data, error } = await supabase.from('progress_logs').insert({
            user_id: user.id,
            weight_kg: kg,
            logged_date: new Date().toISOString().split('T')[0]
          });

          if (!error) {
            const { data: newLogs } = await supabase.from('progress_logs')
              .select('*')
              .eq('user_id', user.id)
              .order('logged_date', { ascending: true });
            if (newLogs) setWeightLogs(newLogs as ProgressLog[]);
          }
        }
      } else if (modalType === 'location') {
        if (val === 'Gym' || val === 'Home') {
          await AsyncStorage.setItem('user:defaultLocation', val);
          setDefaultLocation(val);
          // Regenerate the plan against the new location
          await ensureCurrentWeekPlan({ force: true });
          setSuccessMsg(`Plan rebuilt for ${val}`);
          setTimeout(() => setSuccessMsg(''), 4000);
        }
      }
    } catch (e) {
      reportSilent(e, 'profile:saveField');
    } finally {
      setIsSaving(false);
      setModalType('none');
    }
  };

  const handleSaveNotifTime = async () => {
    const granted = await requestNotificationPermission();
    if (!granted) {
      alert('Please enable notifications in your device settings to use this feature.');
      return;
    }
    let hour = parseInt(notifHourInput, 10);
    const minute = parseInt(notifMinuteInput, 10);
    if (isNaN(hour) || isNaN(minute) || hour < 1 || hour > 12 || minute < 0 || minute > 59) {
      alert('Please enter a valid time.');
      return;
    }
    if (notifAMPM === 'PM' && hour !== 12) hour += 12;
    if (notifAMPM === 'AM' && hour === 12) hour = 0;
    const time: NotifTime = { hour, minute };
    await saveNotifTime(time);
    setNotifTime(time);
    setModalType('none');
    setSuccessMsg('Notification time saved');
    setTimeout(() => setSuccessMsg(''), 3000);

    // Reschedule against current plan if one exists
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      const { data: plans } = await supabase
        .from('weekly_plans')
        .select('plan, week_start')
        .eq('user_id', user.id)
        .lte('week_start', todayStr)
        .order('week_start', { ascending: false })
        .limit(2);

      if (!plans || plans.length === 0) return;

      // Find the active plan (week_start <= today <= week_start + 6)
      const activePlan = plans.find(p => {
        const parts = p.week_start.split('-').map(Number);
        const end = new Date(parts[0], parts[1] - 1, parts[2] + 6);
        const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
        return todayStr <= endStr;
      });

      if (!activePlan) return;

      const plannedDays = activePlan.plan
        .filter((d: any) => d.workoutType !== 'Rest')
        .map((d: any) => d.day);

      await scheduleWorkoutNotifications(plannedDays, activePlan.week_start, time);
    } catch (e) {
      // Scheduling failed silently — time is still saved
      reportSilent(e, 'profile:scheduleNotif');
    }
  };

  const handleDisableNotifications = async () => {
    await cancelAllNotifications();
    await AsyncStorage.removeItem(NOTIF_TIME_KEY);
    setNotifTime(null);
    setModalType('none');
    setSuccessMsg('Notifications disabled');
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const renderGraph = () => {
    if (weightLogs.length < 1) return null;

    // Sort by date
    const sorted = [...weightLogs].sort(
      (a, b) => new Date(a.logged_date).getTime() - new Date(b.logged_date).getTime()
    );
    const weights = sorted.map(l => l.weight_kg);
    const rawMin = Math.min(...weights);
    const rawMax = Math.max(...weights);
    // Pad the range so dots never touch the top/bottom edges.
    const range = Math.max(rawMax - rawMin, 4);
    const minW = rawMin - range * 0.18;
    const maxW = rawMax + range * 0.18;

    // Make the chart fill the card width. ScrollView outer padding = layout.spacing.lg (24).
    // Internal padding = layout.spacing.lg as well so endpoint labels align with first/last point.
    const width = Dimensions.get('window').width - layout.spacing.lg * 2;
    const height = 140;
    const padX = layout.spacing.lg; // 24 — matches the endpoint labels below
    const padTop = 14;
    const padBot = 18;

    const points = sorted.map((log, i) => {
      const x = sorted.length === 1
        ? width / 2
        : padX + (i / (sorted.length - 1)) * (width - padX * 2);
      const y = padTop + (1 - (log.weight_kg - minW) / (maxW - minW)) * (height - padTop - padBot);
      return { x, y };
    });

    // Smooth bezier through all points (Catmull-Rom-ish via midpoint control)
    const computeCurve = (pts: { x: number; y: number }[]) => {
      if (pts.length < 2) return '';
      let d = `M ${pts[0].x},${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const cpx = (pts[i - 1].x + pts[i].x) / 2;
        d += ` C ${cpx},${pts[i - 1].y} ${cpx},${pts[i].y} ${pts[i].x},${pts[i].y}`;
      }
      return d;
    };

    const curvePath = computeCurve(points);
    const bottomY = height - padBot;
    const gradPath = points.length > 1
      ? `${curvePath} L ${points[points.length - 1].x},${bottomY} L ${points[0].x},${bottomY} Z`
      : '';

    return (
      <Svg width={width} height={height} style={{ alignSelf: 'stretch' }}>
        <Defs>
          <LinearGradient id="profileChartGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.accentTeal} stopOpacity="0.28" />
            <Stop offset="1" stopColor={colors.accentTeal} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        {points.length > 1 && <Path d={gradPath} fill="url(#profileChartGrad)" />}
        <Path
          d={curvePath}
          stroke={colors.accentTeal}
          strokeWidth={2}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => {
          const isLast = i === points.length - 1;
          return (
            <Circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={isLast ? 4 : 2.5}
              fill={colors.accentTeal}
              stroke={colors.surface}
              strokeWidth={isLast ? 2.5 : 1.5}
            />
          );
        })}
      </Svg>
    );
  };

  const SettingRow = ({ label, value, onPress, hideChevron }: any) => (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} activeOpacity={0.7} disabled={!onPress}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.settingRight}>
        {value ? <Text style={styles.settingValue}>{value}</Text> : null}
        {!hideChevron && <Text style={styles.chevron}>›</Text>}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {loading ? (
          <View style={styles.loadingContainer}>
            <Skeleton width={100} height={100} borderRadius={layout.cardRadius} colors={colors} />
          </View>
        ) : (
          <>
            {/* HEADER */}
            <View style={styles.profileHeader}>
              <View style={styles.avatarLarge}>
                <Text style={styles.avatarLargeText}>{initial}</Text>
              </View>
              {/* Long-press the username (DEV ONLY) to open the dev-scenario
                  menu. __DEV__ gates the onLongPress handler so production
                  builds attach undefined and the gesture is unreachable —
                  same pattern as the Sentry smoke-test on the dashboard
                  greeting in [app/(tabs)/home.tsx]. The route href is cast
                  because Expo Router's typedRoutes file is auto-generated
                  and stale for files added in the same change set; the
                  route is registered in [app/_layout.tsx] so navigation
                  works at runtime. */}
              <Text
                style={styles.usernameText}
                onLongPress={
                  __DEV__
                    ? () => router.push('/dev-scenarios' as never)
                    : undefined
                }
              >
                {profile?.username}
              </Text>

              <View style={styles.tagsRow}>
                <TouchableOpacity
                  style={[styles.tagPill, !profile?.goal && styles.tagPillEmpty]}
                  onPress={() => openModal('goal')}
                  activeOpacity={0.7}
                >
                  <View style={[styles.tagDot, { backgroundColor: colors.textMuted }]} />
                  <Text style={[styles.tagText, !profile?.goal && styles.tagTextEmpty]}>
                    {profile?.goal ? sanitizeLabel(profile.goal) : 'CHOOSE GOAL'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tagPill, !profile?.fitness_level && styles.tagPillEmpty]}
                  onPress={() => openModal('fitness_level')}
                  activeOpacity={0.7}
                >
                  <View
                    style={[
                      styles.tagDot,
                      {
                        backgroundColor:
                          profile?.fitness_level === 'advanced'
                            ? colors.accentAmber
                            : profile?.fitness_level === 'intermediate'
                              ? colors.accentTeal
                              : colors.textMuted,
                      },
                    ]}
                  />
                  <Text style={[styles.tagText, !profile?.fitness_level && styles.tagTextEmpty]}>
                    {profile?.fitness_level ? sanitizeLabel(profile.fitness_level) : 'PICK LEVEL'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* RECORDS — replaces the redundant stat row */}
            <View style={styles.recordsCard}>
              <View style={styles.recordsHeader}>
                <Text style={styles.recordsTitle}>★ RECORDS</Text>
                <Text style={styles.recordsAllTime}>ALL TIME</Text>
              </View>

              {topPRs.length === 0 ? (
                <Text style={styles.recordsEmpty}>
                  Log a weight on your next workout — your records show up here.
                </Text>
              ) : (
                topPRs.map((pr, idx) => (
                  <View
                    key={pr.exercise_name}
                    style={[styles.recordRow, idx < topPRs.length - 1 && styles.recordRowDivider]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.recordName} numberOfLines={1}>{pr.exercise_name}</Text>
                      <Text style={styles.recordDate}>SET {formatPrDate(pr.logged_date)}</Text>
                    </View>
                    <Text style={styles.recordWeight}>
                      {pr.weight_kg}<Text style={styles.recordWeightUnit}> kg</Text>
                    </Text>
                  </View>
                ))
              )}

              {lifetimeMoved > 0 && (
                <View style={styles.lifetimeRow}>
                  <Text style={styles.lifetimeLabel}>LIFETIME MOVED</Text>
                  <Text style={styles.lifetimeValue}>
                    {lifetimeMoved.toLocaleString()}<Text style={styles.lifetimeUnit}> kg</Text>
                  </Text>
                </View>
              )}
            </View>

            {successMsg ? (
              <Text style={[styles.successText, { marginTop: layout.spacing.lg }]}>{successMsg}</Text>
            ) : <View style={{ height: layout.spacing.xl }} />}


            {weightLogs.length > 0 && (() => {
              const sorted = [...weightLogs].sort(
                (a, b) => new Date(a.logged_date).getTime() - new Date(b.logged_date).getTime()
              );
              const first = sorted[0];
              const last = sorted[sorted.length - 1];
              const hasMultiple = sorted.length > 1;
              const delta = last.weight_kg - first.weight_kg;
              const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} kg`;
              const sinceMonth = (() => {
                const parts = first.logged_date.split('-').map(Number);
                return PR_MONTHS[(parts[1] || 1) - 1] ?? '';
              })();
              const deltaColor =
                delta > 0 ? colors.accentTeal : delta < 0 ? colors.accentCoral : colors.textMuted;

              // Single-entry: just the big number + a one-line nudge.
              // No empty chart, no "—" delta, no awkward endpoint labels.
              if (!hasMultiple) {
                return (
                  <>
                    <Text style={styles.sectionHeader}>BODY WEIGHT</Text>
                    <View style={[styles.sectionCard, { paddingHorizontal: layout.spacing.lg, paddingVertical: layout.spacing.lg }]}>
                      <Text style={styles.weightCurrent}>
                        {last.weight_kg}
                        <Text style={styles.weightCurrentUnit}> kg</Text>
                      </Text>
                      <Text style={[styles.weightCurrentLabel, { marginTop: 6 }]}>CURRENT</Text>
                      <Text style={styles.weightFirstEntryHint}>
                        Log it again next week to see your trend.
                      </Text>
                    </View>
                  </>
                );
              }

              return (
                <>
                  <Text style={styles.sectionHeader}>WEIGHT TREND</Text>
                  <View style={styles.sectionCard}>
                    {/* Headline — current weight + delta vs first entry */}
                    <View style={styles.weightHeadline}>
                      <View>
                        <Text style={styles.weightCurrent}>
                          {last.weight_kg}
                          <Text style={styles.weightCurrentUnit}> kg</Text>
                        </Text>
                        <Text style={styles.weightCurrentLabel}>CURRENT</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={[styles.weightDelta, { color: deltaColor }]}>{deltaStr}</Text>
                        <Text style={styles.weightDeltaLabel}>SINCE {sinceMonth}</Text>
                      </View>
                    </View>

                    {/* Sparkline */}
                    <View style={styles.graphWrapper}>
                      {renderGraph()}
                    </View>

                    {/* Endpoint annotations — start (muted) | now (teal) */}
                    <View style={styles.weightEndpoints}>
                      <Text style={styles.weightEndpointText}>
                        {first.weight_kg} · {sinceMonth}
                      </Text>
                      <Text style={[styles.weightEndpointText, { color: colors.accentTeal }]}>
                        {last.weight_kg} · NOW
                      </Text>
                    </View>
                  </View>
                </>
              );
            })()}

            {/* Settings collapsible — header acts as a toggle button */}
            <TouchableOpacity
              style={styles.settingsToggle}
              onPress={toggleSettings}
              activeOpacity={0.8}
            >
              <Text style={styles.settingsToggleLabel}>SETTINGS</Text>
              <Text style={[styles.settingsToggleChev, { transform: [{ rotate: settingsExpanded ? '90deg' : '0deg' }] }]}>›</Text>
            </TouchableOpacity>

            {settingsExpanded ? (
              <View style={styles.sectionCard}>
                <SettingRow
                  label="Current Split"
                  value={
                    profile?.preferred_split === 'ppl' ? 'Push / Pull / Legs' :
                    profile?.preferred_split === 'upper_lower' ? 'Upper / Lower' :
                    profile?.preferred_split === 'bro_split' ? 'Bro Split' :
                    profile?.preferred_split === 'full_body' ? 'Starter' : 'Not set'
                  }
                  onPress={() => openModal('split')}
                />
                <SettingRow
                  label="Training Days"
                  value={profile?.training_days ? `${profile.training_days} / week` : 'Not set'}
                  onPress={() => openModal('training_days')}
                />
                <SettingRow
                  label="Where you train"
                  value={defaultLocation}
                  onPress={() => openModal('location')}
                />
                <SettingRow label="Current Weight" value={currentWeight ? `${currentWeight} kg` : 'Not logged'} onPress={() => openModal('weight')} />
                <SettingRow
                  label="Workout Reminder"
                  value={notifTime
                    ? (() => {
                      const isPM = notifTime.hour >= 12;
                      const h = notifTime.hour % 12 === 0 ? 12 : notifTime.hour % 12;
                      const m = String(notifTime.minute).padStart(2, '0');
                      return `${h}:${m} ${isPM ? 'PM' : 'AM'}`;
                    })()
                    : 'Off'
                  }
                  onPress={() => openModal('notifications')}
                />
                <SettingRow label="Edit Name" value="" onPress={() => openModal('name')} />
                <SettingRow
                  label="Send feedback"
                  value=""
                  onPress={() => {
                    const subject = encodeURIComponent('Intr feedback');
                    const body = encodeURIComponent(
                      `\n\n— sent from Intr v1.0.0 (${Platform.OS})`
                    );
                    Linking.openURL(`mailto:labidiomar04@gmail.com?subject=${subject}&body=${body}`);
                  }}
                />
              </View>
            ) : null}

            {/* Legal — Privacy Policy + Terms of Use, opened in an in-app
                browser tab. Required for the Play listing and linked here so
                users can reach them without leaving the app. */}
            <Text style={styles.sectionHeader}>LEGAL</Text>
            <View style={styles.sectionCard}>
              <SettingRow label="Privacy Policy" value="" onPress={() => openLegal(PRIVACY_URL)} />
              <SettingRow label="Terms of Use" value="" onPress={() => openLegal(TERMS_URL)} />
            </View>

            {/* Log Out — pulled outside the settings group; coral outlined, with metadata */}
            <TouchableOpacity style={styles.logoutOuter} onPress={handleLogout} activeOpacity={0.7}>
              <Text style={styles.logoutOuterText}>Log Out</Text>
            </TouchableOpacity>
            {profile?.username ? (
              <Text style={styles.signedInMeta}>
                SIGNED IN AS {profile.username.toUpperCase()}
                {daysSinceSignup > 0 ? ` · ${daysSinceSignup} ${daysSinceSignup === 1 ? 'DAY' : 'DAYS'}` : ''}
              </Text>
            ) : null}

            {/* Delete account — destructive. Tap opens a typed-confirm
                modal so a single accidental tap can't trigger it. */}
            <TouchableOpacity
              style={styles.deleteAccountBtn}
              onPress={openDeleteModal}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Delete account"
            >
              <Text style={styles.deleteAccountText}>Delete account</Text>
            </TouchableOpacity>

          </>
        )}

        {/* Build marker — unobtrusive footer. Bump src/constants/buildInfo.ts
            on every change you want to confirm on device. If a reload didn't
            pick up the new bundle the tag here will lag behind the source. */}
        <Text style={styles.buildTag}>build {BUILD_TAG}</Text>
      </ScrollView>

      {/* REUSABLE BOTTOM SHEET MODAL */}
      <Modal visible={modalType !== 'none'} transparent animationType="slide">
        <TouchableWithoutFeedback onPress={() => setModalType('none')}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.bottomSheet}>
                <View style={styles.sheetHandle} />

                {modalType === 'weight' && (
                  <View>
                    <Text style={styles.sheetTitle}>Log your weight</Text>
                    <TextInput
                      style={styles.sheetInput}
                      value={inputValue}
                      onChangeText={setInputValue}
                      keyboardType="numeric"
                      placeholder="e.g. 75"
                      placeholderTextColor={colors.textSecondary}
                      autoFocus
                    />
                    <Button title="Save Weight" onPress={() => handleSaveModal()} loading={isSaving} style={{ marginTop: 24 }} />
                  </View>
                )}

                {modalType === 'name' && (
                  <View>
                    <Text style={styles.sheetTitle}>Edit Username</Text>
                    <TextInput
                      style={styles.sheetInput}
                      value={inputValue}
                      onChangeText={setInputValue}
                      placeholder="Your name"
                      placeholderTextColor={colors.textSecondary}
                      autoFocus
                    />
                    <Button title="Save Name" onPress={() => handleSaveModal()} loading={isSaving} style={{ marginTop: 24 }} />
                  </View>
                )}

                {modalType === 'goal' && (
                  <View>
                    <Text style={styles.sheetTitle}>What's your goal?</Text>
                    {GOAL_OPTIONS.map(opt => {
                      const isActive = profile?.goal === opt.value;
                      return (
                        <TouchableOpacity
                          key={opt.value}
                          style={[styles.sheetOptionBtn, isActive && styles.sheetOptionBtnActive]}
                          onPress={() => handleSaveModal(opt.value)}
                        >
                          <Text style={[styles.sheetOptionText, isActive && styles.sheetOptionTextActive]}>
                            {opt.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {modalType === 'fitness_level' && (
                  <View>
                    <Text style={styles.sheetTitle}>Change Fitness Level</Text>
                    {FITNESS_LEVEL_OPTIONS.map(opt => (
                      <TouchableOpacity
                        key={opt}
                        style={[styles.sheetOptionBtn, profile?.fitness_level === opt && styles.sheetOptionBtnActive]}
                        onPress={() => handleSaveModal(opt)}
                      >
                        <Text style={[styles.sheetOptionText, profile?.fitness_level === opt && styles.sheetOptionTextActive]}>
                          {opt.charAt(0).toUpperCase() + opt.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {modalType === 'split' && (
                  <View>
                    <Text style={styles.sheetTitle}>Change Split</Text>
                    {SPLIT_OPTIONS.map(opt => (
                      <TouchableOpacity
                        key={opt.id}
                        style={[styles.sheetOptionBtn, profile?.preferred_split === opt.id && styles.sheetOptionBtnActive]}
                        onPress={() => handleSaveModal(opt.id)}
                      >
                        <Text style={[styles.sheetOptionText, profile?.preferred_split === opt.id && styles.sheetOptionTextActive]}>
                          {opt.title}
                        </Text>
                        <Text style={styles.sheetOptionDesc}>{opt.desc}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {modalType === 'location' && (
                  <View>
                    <Text style={styles.sheetTitle}>Where you train</Text>
                    <Text style={[styles.sheetOptionDesc, { marginBottom: layout.spacing.md }]}>
                      Changing this rebuilds your plan with the right exercises.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {LOCATION_OPTIONS.map(opt => {
                        const isActive = defaultLocation === opt.value;
                        return (
                          <TouchableOpacity
                            key={opt.value}
                            style={[
                              {
                                flex: 1,
                                height: 56,
                                borderRadius: layout.cardRadius,
                                borderWidth: 1,
                                borderColor: isActive ? colors.accentTeal : colors.cardBorder,
                                backgroundColor: isActive ? colors.surfaceElevated : colors.background,
                                alignItems: 'center',
                                justifyContent: 'center',
                              },
                            ]}
                            onPress={() => handleSaveModal(opt.value)}
                          >
                            <Text style={{
                              fontFamily: typography.family.heading,
                              fontSize: typography.size.md,
                              color: isActive ? colors.accentTeal : colors.textPrimary,
                            }}>
                              {opt.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}

                {modalType === 'training_days' && (
                  <View>
                    <Text style={styles.sheetTitle}>Which days can you train?</Text>
                    <Text style={[styles.sheetOptionDesc, { marginBottom: layout.spacing.md }]}>
                      Pick the weekdays you're available. Changing this rebuilds your plan.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {WEEKDAY_LAYOUT.map(opt => {
                        const isActive = editingWeekdays.includes(opt.value);
                        const atCap = !isActive && editingWeekdays.length >= MAX_WEEKDAYS_PICK;
                        return (
                          <TouchableOpacity
                            key={opt.value}
                            style={[
                              {
                                flex: 1,
                                height: 56,
                                borderRadius: layout.cardRadius,
                                borderWidth: 1,
                                borderColor: isActive ? colors.accentTeal : colors.cardBorder,
                                backgroundColor: isActive ? colors.surfaceElevated : colors.background,
                                alignItems: 'center',
                                justifyContent: 'center',
                                opacity: atCap ? 0.4 : 1,
                              },
                            ]}
                            onPress={() => toggleEditingWeekday(opt.value)}
                            disabled={atCap}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isActive }}
                            accessibilityLabel={`Toggle ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][opt.value]}`}
                          >
                            <Text style={{
                              fontFamily: typography.family.heading,
                              fontSize: typography.size.md,
                              color: isActive ? colors.accentTeal : colors.textPrimary,
                            }}>
                              {opt.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <Text style={[styles.sheetOptionDesc, { marginTop: layout.spacing.sm }]}>
                      {editingWeekdays.length < MIN_WEEKDAYS_PICK
                        ? `Pick at least ${MIN_WEEKDAYS_PICK} days.`
                        : `${editingWeekdays.length} day${editingWeekdays.length === 1 ? '' : 's'} a week.`}
                    </Text>
                    {hasConsecutiveRun(editingWeekdays, 3) && (
                      <Text style={[styles.sheetOptionDesc, { color: colors.accentAmber, marginTop: 4 }]}>
                        Heads-up: three or more days in a row leaves little time to recover. Spread them out if you can.
                      </Text>
                    )}
                    <Button
                      title={isSaving ? 'Saving…' : 'Save'}
                      onPress={() => { void saveWeekdaysEdit(); }}
                      loading={isSaving}
                      disabled={
                        editingWeekdays.length < MIN_WEEKDAYS_PICK ||
                        editingWeekdays.length > MAX_WEEKDAYS_PICK
                      }
                      style={{ marginTop: layout.spacing.lg }}
                    />
                  </View>
                )}

                {modalType === 'notifications' && (
                  <View>
                    <Text style={styles.sheetTitle}>Workout Reminder</Text>
                    <View style={styles.notifTimeRow}>
                      <TextInput
                        style={styles.notifTimeInput}
                        value={notifHourInput}
                        onChangeText={setNotifHourInput}
                        keyboardType="number-pad"
                        maxLength={2}
                        placeholder="HH"
                        placeholderTextColor={colors.textMuted}
                      />
                      <Text style={styles.notifTimeSeparator}>:</Text>
                      <TextInput
                        style={styles.notifTimeInput}
                        value={notifMinuteInput}
                        onChangeText={setNotifMinuteInput}
                        keyboardType="number-pad"
                        maxLength={2}
                        placeholder="MM"
                        placeholderTextColor={colors.textMuted}
                      />
                      <TouchableOpacity
                        style={[styles.notifAMPMBtn, notifAMPM === 'AM' && styles.notifAMPMBtnActive]}
                        onPress={() => setNotifAMPM('AM')}
                      >
                        <Text style={[styles.notifAMPMText, notifAMPM === 'AM' && styles.notifAMPMTextActive]}>AM</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.notifAMPMBtn, notifAMPM === 'PM' && styles.notifAMPMBtnActive]}
                        onPress={() => setNotifAMPM('PM')}
                      >
                        <Text style={[styles.notifAMPMText, notifAMPM === 'PM' && styles.notifAMPMTextActive]}>PM</Text>
                      </TouchableOpacity>
                    </View>
                    <Button title="Save Reminder" onPress={handleSaveNotifTime} loading={isSaving} style={{ marginTop: 24 }} />
                    {notifTime && (
                      <TouchableOpacity style={styles.disableNotifBtn} onPress={handleDisableNotifications} activeOpacity={0.7}>
                        <Text style={styles.disableNotifText}>Turn Off Reminders</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* DELETE ACCOUNT CONFIRMATION ──────────────────────────────────
          Typed-confirm gate. Visual structure top-to-bottom:
            1. Red glyph in a tinted circle — destructive brand at a glance
            2. Centered title
            3. Subhead: "This permanently removes:"
            4. Bulleted consequences list (one item per row)
            5. Hairline separator + "This cannot be undone."
            6. Subscription caveat (when isPro)
            7. Prompt label + text input (visibly a FIELD, not a button)
            8. Inline error (when present — modal stays open)
            9. Actions: Cancel (text-only, neutral) + Delete (red filled)
          Backdrop tap is no-op while a delete is in flight. */}
      <Modal
        visible={showDeleteModal}
        transparent
        animationType="fade"
        onRequestClose={closeDeleteModal}
      >
        <TouchableWithoutFeedback onPress={closeDeleteModal}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.deleteModalSheet}>
                {/* 1. Destructive glyph — a red-tinted circle with the
                       universal "warning" mark. Brands the dialog as
                       destructive before the user reads a single word. */}
                <View style={styles.deleteModalIconWrap}>
                  <Text style={styles.deleteModalIconGlyph}>!</Text>
                </View>

                {/* 2. Title */}
                <Text style={styles.deleteModalTitle}>Delete account</Text>

                {/* 3. Subhead */}
                <Text style={styles.deleteModalSubhead}>
                  This permanently removes:
                </Text>

                {/* 4. Consequences as a real list — each row has a bullet
                       glyph and breathes independently. Easier to scan than
                       a dense comma-separated paragraph. */}
                <View style={styles.deleteModalList}>
                  {[
                    'Profile and onboarding data',
                    'Weekly plan and coach messages',
                    'Workout history and exercise logs',
                    'Daily check-ins and journal entries',
                  ].map(item => (
                    <View key={item} style={styles.deleteModalListRow}>
                      <Text style={styles.deleteModalBullet}>•</Text>
                      <Text style={styles.deleteModalListText}>{item}</Text>
                    </View>
                  ))}
                </View>

                {/* 5. Hairline + irreversibility callout */}
                <View style={styles.deleteModalHairline} />
                <Text style={styles.deleteModalIrreversible}>
                  This cannot be undone.
                </Text>

                {/* 6. Subscription caveat — only when isPro is true. Amber
                       so it reads as info, not danger. */}
                {hasActiveSubscription && (
                  <View style={styles.deleteModalSubNote}>
                    <Text style={styles.deleteModalSubNoteText}>
                      Your subscription is billed by the App Store or
                      Google Play. We can't cancel it from here — manage
                      it in your store settings.
                    </Text>
                  </View>
                )}

                {/* 7. The input. Styled as a clear FIELD:
                       - Small-caps label above (matches form labels)
                       - Recessed background + 1px border so it reads as
                         interactive surface, not a solid button
                       - Left-aligned text, left-aligned placeholder
                       - Border picks up the accent color once the user
                         types DELETE correctly — confirms the gate */}
                <Text style={styles.deleteModalFieldLabel}>TYPE DELETE TO CONFIRM</Text>
                <TextInput
                  style={[
                    styles.deleteModalInput,
                    deleteConfirmText === 'DELETE' && styles.deleteModalInputValid,
                  ]}
                  value={deleteConfirmText}
                  onChangeText={setDeleteConfirmText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!isDeleting}
                  placeholder="Type DELETE"
                  placeholderTextColor={colors.textMuted}
                  returnKeyType="done"
                />

                {/* 8. Inline error — left-aligned, sits between input and
                       actions so the user reads it before tapping retry. */}
                {deleteError ? (
                  <Text style={styles.deleteModalError}>{deleteError}</Text>
                ) : null}

                {/* 9. Actions — Cancel is text-only neutral, Delete is the
                       single solid affordance. Cancel deliberately does NOT
                       compete visually with Delete; the typed-confirm gate
                       (not button prominence) is what prevents an accidental
                       destructive tap. */}
                <View style={styles.deleteModalActions}>
                  <TouchableOpacity
                    onPress={closeDeleteModal}
                    disabled={isDeleting}
                    activeOpacity={0.6}
                    style={styles.deleteModalCancelBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                  >
                    <Text style={styles.deleteModalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleConfirmDelete}
                    disabled={deleteConfirmText !== 'DELETE' || isDeleting}
                    activeOpacity={0.85}
                    style={[
                      styles.deleteModalConfirmBtn,
                      (deleteConfirmText !== 'DELETE' || isDeleting) && styles.deleteModalConfirmBtnDisabled,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Delete account permanently"
                  >
                    <Text style={styles.deleteModalConfirmText}>
                      {isDeleting ? 'Deleting…' : 'Delete account'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────

const makeStyles = (colors: any) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    paddingHorizontal: layout.spacing.lg,
    paddingBottom: layout.spacing.xxl,
  },
  loadingContainer: {
    alignItems: 'center',
    marginTop: 32,
  },

  // ── Profile Header ──────────────────────
  profileHeader: {
    alignItems: 'center',
    marginTop: layout.spacing.xl,
    marginBottom: layout.spacing.lg,
  },
  avatarLarge: {
    width: 100,
    height: 100,
    borderRadius: layout.smRadius,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 2,
    borderColor: colors.accentTeal,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: layout.spacing.md,
  },
  avatarLargeText: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s40,
    color: colors.textPrimary,
  },
  usernameText: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    color: colors.textPrimary,
    marginBottom: layout.spacing.sm,
    letterSpacing: typography.letterSpacing.heading,
  },
  tagsRow: {
    flexDirection: 'row',
    gap: layout.spacing.xs,
  },
  tagPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: layout.pillRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: 'transparent',
  },
  tagDot: {
    width: 5,
    height: 5,
    borderRadius: layout.radii.r2_5,
  },
  tagText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s10,
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: colors.textPrimary,
  },
  tagPillEmpty: {
    borderColor: colors.accentTeal,
    borderStyle: 'dashed',
  },
  tagTextEmpty: {
    color: colors.accentTeal,
  },

  // ── Records block ──────────────────────
  recordsCard: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
    marginBottom: layout.spacing.sm,
  },
  recordsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 12,
  },
  recordsTitle: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s10,
    letterSpacing: 2,
    color: colors.accentAmber,
  },
  recordsAllTime: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s9_5,
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  recordsEmpty: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s13,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingVertical: 8,
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  recordRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  recordName: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s13_5,
    letterSpacing: -0.2,
    color: colors.textPrimary,
  },
  recordDate: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s9_5,
    letterSpacing: 1,
    color: colors.textMuted,
    marginTop: 2,
  },
  recordWeight: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s19,
    letterSpacing: -0.4,
    color: colors.accentAmber,
  },
  recordWeightUnit: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    color: colors.textMuted,
  },
  lifetimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  lifetimeLabel: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  lifetimeValue: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s16,
    letterSpacing: -0.3,
    color: colors.textPrimary,
  },
  lifetimeUnit: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    color: colors.textMuted,
  },

  // ── Success Message ─────────────────────
  successText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.accentTeal,
    textAlign: 'center',
    marginBottom: layout.spacing.sm,
  },

  // ── Settings toggle button ─────────────
  settingsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: layout.spacing.lg,
    marginBottom: layout.spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  settingsToggleLabel: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s11,
    letterSpacing: 2,
    color: colors.textSecondary,
    textTransform: 'uppercase',
  },
  settingsToggleChev: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s20,
    color: colors.textMuted,
    lineHeight: 20,
  },

  // ── Section Header ─────────────────────
  sectionHeader: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xs,
    color: colors.textSecondary,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: layout.spacing.sm,
    marginTop: layout.spacing.lg,
  },

  // ── Section Card ───────────────────────
  sectionCard: {
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    overflow: 'hidden',
  },

  // ── Weight Trend headline ─────────────
  weightHeadline: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: layout.spacing.lg,
    paddingTop: layout.spacing.lg,
    paddingBottom: layout.spacing.md,
    width: '100%',
    gap: layout.spacing.md,
  },
  weightCurrent: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s28,
    letterSpacing: -0.7,
    color: colors.textPrimary,
    lineHeight: 30,
    fontVariant: ['tabular-nums'],
  },
  weightCurrentUnit: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s13,
    color: colors.textMuted,
  },
  weightCurrentLabel: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginTop: 4,
  },
  weightFirstEntryHint: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    color: colors.textSecondary,
    marginTop: layout.spacing.md,
    lineHeight: 18,
  },
  weightDelta: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s14,
    letterSpacing: 0.4,
    fontVariant: ['tabular-nums'],
  },
  weightDeltaLabel: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s9_5,
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginTop: 2,
  },
  weightEndpoints: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: layout.spacing.lg - 6, // pull labels slightly outside chart padX so they sit under the dot
    paddingBottom: layout.spacing.md,
    marginTop: 2,
  },
  weightEndpointText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s9_5,
    letterSpacing: 1.5,
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },

  // ── Graph ─────────────────────────────
  graphWrapper: {
    width: '100%',
    paddingVertical: layout.spacing.xs,
  },

  // ── Settings ──────────────────────────
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  settingLabel: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s13,
    color: colors.textPrimary,
    flexShrink: 1,
    marginRight: layout.spacing.md,
    letterSpacing: -0.1,
  },
  settingRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  settingValue: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12_5,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.1,
  },
  chevron: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s20,
    color: colors.textMuted,
    marginLeft: 4,
  },
  logoutOuter: {
    marginTop: layout.spacing.xl + layout.spacing.xs,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.accentCoral + '4D', // ~30% opacity coral mix
    borderRadius: layout.cardRadius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  logoutOuterText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.sm,
    color: colors.accentCoral,
    letterSpacing: 0.3,
  },
  signedInMeta: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s9_5,
    letterSpacing: 1.5,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },

  // ── Modal / Bottom Sheet ──────────────
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.scrimMedium,
  },
  bottomSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: layout.cardRadius,
    borderTopRightRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderBottomWidth: 0,
    paddingHorizontal: layout.spacing.lg,
    paddingBottom: layout.spacing.xxl,
    paddingTop: layout.spacing.md,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: layout.smRadius,
    backgroundColor: colors.textMuted,
    alignSelf: 'center',
    marginBottom: layout.spacing.lg,
  },
  sheetTitle: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    color: colors.textPrimary,
    marginBottom: layout.spacing.lg,
    letterSpacing: typography.letterSpacing.heading,
  },
  sheetInput: {
    fontFamily: typography.family.body,
    fontSize: typography.size.md,
    color: colors.textPrimary,
    backgroundColor: colors.background,
    borderRadius: layout.smRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: layout.spacing.md,
    paddingVertical: layout.spacing.sm,
    height: 52,
  },
  sheetOptionBtn: {
    paddingHorizontal: layout.spacing.lg,
    paddingVertical: layout.spacing.md,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: layout.spacing.sm,
    backgroundColor: colors.background,
  },
  sheetOptionBtnActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.surfaceElevated,
  },
  sheetOptionText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textPrimary,
  },
  sheetOptionTextActive: {
    color: colors.accentTeal,
    fontFamily: typography.family.bodyMedium,
  },
  sheetOptionDesc: {
    fontFamily: typography.family.body,
    fontSize: typography.size.xs,
    color: colors.textMuted,
    marginTop: 4,
  },

  // ── Notification Time Picker ──────────
  notifTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: layout.spacing.sm,
    marginBottom: layout.spacing.sm,
  },
  notifTimeInput: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s28,
    color: colors.textPrimary,
    backgroundColor: colors.background,
    borderRadius: layout.smRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    width: 70,
    height: 60,
    textAlign: 'center',
  },
  notifTimeSeparator: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s28,
    color: colors.textSecondary,
  },
  notifAMPMBtn: {
    paddingHorizontal: layout.spacing.md,
    paddingVertical: layout.spacing.sm,
    borderRadius: layout.smRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.background,
  },
  notifAMPMBtnActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.surfaceElevated,
  },
  notifAMPMText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.sm,
    color: colors.textSecondary,
  },
  notifAMPMTextActive: {
    color: colors.accentTeal,
  },
  disableNotifBtn: {
    marginTop: layout.spacing.lg,
    alignItems: 'center',
    paddingVertical: layout.spacing.sm,
  },
  disableNotifText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textMuted,
    textDecorationLine: 'underline',
  },
  // ── Delete-account button (in the profile body) ──────────────────────
  // Less prominent than Log Out (which is the everyday action). Sits below
  // the signed-in-as metadata as a destructive footer.
  deleteAccountBtn: {
    marginTop: layout.spacing.lg,
    paddingVertical: layout.spacing.sm,
    alignItems: 'center',
  },
  deleteAccountText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.accentRed,
    textDecorationLine: 'underline',
    letterSpacing: 0.3,
  },
  // ── Delete-account confirmation modal ────────────────────────────────
  // Decision dialog, not a form. Vertical rhythm: icon → title → subhead →
  // bulleted list → hairline → irreversibility → (subscription) → field
  // label → input → error → actions. Each section has its own breathing
  // room so the user reads top-to-bottom rather than scanning a wall.
  deleteModalSheet: {
    width: '90%',
    maxWidth: 440,
    backgroundColor: colors.surface,
    borderRadius: layout.cardRadius,
    // 1px subtle border — the red lives in the glyph and the action button,
    // not the whole frame. A red box felt panicky.
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: layout.spacing.lg,
    paddingTop: layout.spacing.lg,
    paddingBottom: layout.spacing.lg,
  },

  // ── 1. Destructive glyph ─────────────────────────────────────────────
  // 56px circle, centered, tinted-red background + accentRed border so the
  // dialog is visually branded as destructive before any text is read.
  deleteModalIconWrap: {
    width: 56,
    height: 56,
    borderRadius: layout.radii.r28,
    borderWidth: 1.5,
    borderColor: colors.accentRed,
    backgroundColor: 'rgba(239,68,68,0.10)',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: layout.spacing.md,
  },
  deleteModalIconGlyph: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s28,
    lineHeight: 32,
    color: colors.accentRed,
    textAlign: 'center',
  },

  // ── 2. Title ─────────────────────────────────────────────────────────
  deleteModalTitle: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s22,
    color: colors.textPrimary,
    textAlign: 'center',
    letterSpacing: 0.1,
    marginBottom: layout.spacing.xs,
  },

  // ── 3. Subhead ───────────────────────────────────────────────────────
  deleteModalSubhead: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s13,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: layout.spacing.md,
  },

  // ── 4. Consequences list ─────────────────────────────────────────────
  // One item per row. Bullet glyph is a separate Text so the wrapping of
  // long item text doesn't push the bullet around — the indentation stays
  // clean even when text reflows.
  deleteModalList: {
    width: '100%',
    paddingHorizontal: layout.spacing.xs,
    marginBottom: layout.spacing.md,
    gap: 6,
  },
  deleteModalListRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  deleteModalBullet: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s14,
    lineHeight: 20,
    color: colors.accentRed,
    width: 14,
    textAlign: 'center',
  },
  deleteModalListText: {
    flex: 1,
    fontFamily: typography.family.body,
    fontSize: typography.size.s14,
    lineHeight: 20,
    color: colors.textPrimary,
  },

  // ── 5. Hairline + irreversibility callout ────────────────────────────
  deleteModalHairline: {
    height: 1,
    backgroundColor: colors.cardBorder,
    marginBottom: layout.spacing.sm,
  },
  // Bold-weight body, accentRed, centered — the line that has to land.
  deleteModalIrreversible: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s14,
    color: colors.accentRed,
    textAlign: 'center',
    letterSpacing: 0.3,
    marginBottom: layout.spacing.md,
  },

  // ── 6. Subscription caveat (amber, info-not-danger) ──────────────────
  deleteModalSubNote: {
    borderWidth: 1,
    borderColor: colors.accentAmber,
    borderRadius: layout.smRadius,
    paddingHorizontal: layout.spacing.sm,
    paddingVertical: 10,
    marginBottom: layout.spacing.md,
    backgroundColor: 'rgba(245,158,11,0.06)',
  },
  deleteModalSubNoteText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    lineHeight: 17,
    color: colors.textPrimary,
  },

  // ── 7. Field label + input ───────────────────────────────────────────
  // Small-caps label sits above the field, same pattern as other forms
  // in the app — makes the input read as a labelled form field, not as a
  // button with a hint.
  deleteModalFieldLabel: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s11,
    letterSpacing: 1.4,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  // FIELD STYLING — the visual fix. Previously this read as a solid dark
  // button. Now:
  //   - Recessed background (background, one step below surface) so the
  //     field reads as a hollow input, not a raised button.
  //   - Visible 1px border that the eye can follow as a field boundary.
  //   - Left-aligned text and placeholder so the caret rests at the start,
  //     not in the middle where it would look like centered button copy.
  //   - Smaller letter-spacing than the destructive button to differentiate.
  //   - Border picks up the accent ONLY when typed correctly — confirms
  //     the gate without making the field itself a "button".
  deleteModalInput: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s16,
    letterSpacing: 0.5,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.smRadius,
    backgroundColor: colors.background,
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlign: 'left',
    marginBottom: layout.spacing.md,
    minHeight: 46,
  },
  deleteModalInputValid: {
    borderColor: colors.accentRed,
    borderWidth: 1.5,
  },

  // ── 8. Inline error ──────────────────────────────────────────────────
  deleteModalError: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s13,
    lineHeight: 18,
    color: colors.accentRed,
    marginBottom: layout.spacing.md,
    textAlign: 'left',
  },

  // ── 9. Actions ───────────────────────────────────────────────────────
  // Cancel is a ghost text button so the destructive Delete button is the
  // single solid affordance on the dialog. The typed-confirm gate is what
  // prevents accidental destruction, not button prominence.
  deleteModalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 4,
  },
  deleteModalCancelBtn: {
    paddingVertical: 12,
    paddingHorizontal: layout.spacing.md,
    // No border, no fill — text-only so it visually defers to Delete.
    backgroundColor: 'transparent',
  },
  deleteModalCancelText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s14,
    color: colors.textSecondary,
    letterSpacing: 0.2,
  },
  // Destructive button — solid red when enabled, dimmed when the typed
  // gate hasn't passed. Higher contrast text on the red fill (white-ish)
  // so it's unmistakably the action.
  deleteModalConfirmBtn: {
    paddingVertical: 12,
    paddingHorizontal: layout.spacing.lg,
    borderRadius: layout.smRadius,
    backgroundColor: colors.accentRed,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 150,
  },
  deleteModalConfirmBtnDisabled: {
    opacity: 0.32,
  },
  deleteModalConfirmText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s14,
    color: colors.textPrimary,
    letterSpacing: 0.3,
  },
  // Build marker — footer-style. Muted, small, all the visual weight of a
  // copyright line. Not a banner.
  buildTag: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s11,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: layout.spacing.xl,
    marginBottom: layout.spacing.lg,
    letterSpacing: 0.6,
    opacity: 0.7,
  },
});