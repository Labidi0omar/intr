import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import PagerView from 'react-native-pager-view';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../src/context/ThemeContext';
import { supabase } from '../src/lib/supabase';
import { track } from '../src/lib/analytics';
import { splitForDays, type FitnessLevel, type SplitId } from '../src/lib/planGeneration';
import { ensureCurrentWeekPlan, writeCachedProfileInputs } from '../src/lib/planSync';
import { enableNotificationsIfFirstTime } from '../src/utils/notifications';
import { layout, typography } from '../src/theme';
import { hasConsecutiveRun } from '../src/utils/trainingWeekdays';
import { reportSilent } from '../src/lib/errorReporting';
import {
  ANCHOR_LIFTS,
  ANCHOR_SEED_NOTES_STORAGE_KEY,
  buildAnchorSeedRows,
  parseAnchorEntry,
  type AnchorEntry,
  type AnchorLiftKey,
} from '../src/lib/anchorSeed';

// Three taps to a real first workout.
// We intentionally collect ONLY the minimum needed to generate a plan:
//   - fitness level   (training intensity / exercise pool)
//   - training days   (frequency)
//   - workout split   (which muscles land on which day)
//   - location        (gym vs home — which equipment pool to draw from)
// Location defaults to Gym (matches the pre-existing hardcoded default) but
// is now a step-2 toggle rather than Profile-tab-only; it's still editable
// there later. Username and other profile fields stay back-fillable from
// Profile — never block activation on them. Defaults: days=3,
// split=splitForDays(3), location=Gym.
//
// Layout: the flow is a 3-step swipeable pager (react-native-pager-view).
// Step 1 = training schedule (level + weekdays + split); step 2 = goal +
// where-you-train (gym/home) + optional bodyweight/sex; step 3 = optional
// anchor-lift numbers (what are you lifting these days?) + Start training.
// isValid stays keyed on level + goal + weekdays count — nothing on step 2
// past goal, and nothing on step 3, is required. Skipping the anchor rows
// (leaving every one blank) is a first-class, fully supported path:
// session one just falls back to the plain calibration Coach's Call line
// instead of a seeded number.
//
// The "priority" chip step (an area/lift to focus on) was removed — the
// product call was that it added a decision without enough payoff for the
// time it cost. profiles.priority is still written on every submit, just
// always NULL now; every downstream reader (coachObservations.
// buildPlanRationale, home.tsx) already treats NULL as "no priority set",
// a state that existed before this change (skipping the chip was always
// allowed), so no reader needed to change.

// Weekday picker. Order rendered as Mon..Sun (week-start convention used by
// most fitness apps); values are JS Date.getDay() indices (0=Sun..6=Sat) so
// they pair directly with `training_weekdays` storage and `weekdaysToOffsets`.
const WEEKDAY_LAYOUT: { value: number; label: string }[] = [
  { value: 1, label: 'M' },
  { value: 2, label: 'T' },
  { value: 3, label: 'W' },
  { value: 4, label: 'T' },
  { value: 5, label: 'F' },
  { value: 6, label: 'S' },
  { value: 0, label: 'S' },
];
const MIN_WEEKDAYS = 3;
const MAX_WEEKDAYS = 6;
// Default to Mon/Wed/Fri — the most common 3-day pattern, spaced for recovery.
const DEFAULT_WEEKDAYS = [1, 3, 5];
const LEVELS: { value: FitnessLevel; label: string; hint: string }[] = [
  { value: 'beginner', label: 'Beginner', hint: '< 1 yr' },
  { value: 'intermediate', label: 'Intermediate', hint: '1–3 yrs' },
  { value: 'advanced', label: 'Advanced', hint: '3+ yrs' },
];
// Plain labels + a one-line description each. The user's pick is authoritative
// — it's saved as preferred_split and drives generation (the generator no
// longer derives the split from the day count).
const SPLIT_OPTIONS: { value: SplitId; label: string; desc: string }[] = [
  { value: 'full_body', label: 'Full Body', desc: 'Every session trains your whole body.' },
  { value: 'upper_lower', label: 'Upper / Lower', desc: 'Alternate upper-body and lower-body days.' },
  { value: 'ppl', label: 'Push / Pull / Legs', desc: 'Push, pull, and legs each get their own day.' },
  { value: 'bro_split', label: 'Bro Split', desc: 'One body-part per day — chest, back, shoulders, arms, legs.' },
];

// Goal — one of three. Required (the only new field that blocks submit).
// Stored verbatim on profiles.goal; consumed by buildPlanRationale phrasing
// and (later) by volume / rep-range biasing.
type Goal = 'strength' | 'muscle' | 'general';
const GOAL_OPTIONS: { value: Goal; label: string; desc: string }[] = [
  { value: 'strength', label: 'Strength', desc: 'Heavier numbers on the big lifts.' },
  { value: 'muscle', label: 'Muscle', desc: 'Bigger, more visible muscle.' },
  { value: 'general', label: 'General', desc: 'Move better, feel stronger.' },
];

// Where the user trains — sets the location preference (AsyncStorage
// 'user:defaultLocation') that ensureCurrentWeekPlan reads when assembling
// the exercise pool. Always has a value (defaults to Gym); this is NOT
// optional the way bodyweight/sex are, it just isn't part of isValid
// because a sensible default already exists.
type OnboardingLocation = 'Gym' | 'Home';
const LOCATION_OPTIONS: { value: OnboardingLocation; label: string; hint: string }[] = [
  { value: 'Gym', label: 'Gym', hint: 'Full equipment' },
  { value: 'Home', label: 'Home', hint: 'Bodyweight + basics' },
];

// Narrowed to the two options the UI actually offers. The legacy
// 'unspecified' string still lives in the DB for users who onboarded
// before this change; new signups can only pick 'male' or 'female' (or
// skip entirely → null).
type Sex = 'male' | 'female';
const SEX_OPTIONS: { value: Sex; label: string }[] = [
  { value: 'male', label: 'M' },
  { value: 'female', label: 'F' },
];

// Bodyweight bounds match the migration's CHECK so a value the DB will accept
// is the same set the UI lets through. Anything outside this range gets
// quietly dropped before submit (not surfaced as an error — the field is
// skippable; an unparseable input simply means "no seed").
const BODYWEIGHT_MIN_KG = 25;
const BODYWEIGHT_MAX_KG = 300;

// Pager pages, in order. Kept as a literal tuple so `step: 0 | 1 | 2` is
// exhaustive against `TOTAL_STEPS - 1` at the type level.
const TOTAL_STEPS = 3;

// Empty starting shape for the anchor-lift inputs — every field blank,
// every row independently optional. Rebuilt fresh (not shared) at each
// call site that needs a reset shape.
const emptyAnchorInputs = (): Record<AnchorLiftKey, { weight: string; reps: string }> => ({
  bench: { weight: '', reps: '' },
  squat: { weight: '', reps: '' },
  deadlift: { weight: '', reps: '' },
  overhead: { weight: '', reps: '' },
  row: { weight: '', reps: '' },
});

export default function OnboardingScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();

  const [level, setLevel] = useState<FitnessLevel | null>(null);
  // Calendar weekdays the user can train on (0=Sun..6=Sat). The number of
  // selected weekdays IS the training-days count — there's no separate
  // count input. Enforced 3..6 in the UI; legacy / 1-2-7-day users live
  // outside this picker (existing rows untouched).
  const [weekdays, setWeekdays] = useState<number[]>(DEFAULT_WEEKDAYS);
  const days = weekdays.length;
  // Split is pre-selected from the day count as a sensible default, but the
  // user's pick is authoritative. `splitTouched` stops the days-driven default
  // from overriding an explicit choice.
  const [split, setSplit] = useState<SplitId>(splitForDays(DEFAULT_WEEKDAYS.length));
  const [splitTouched, setSplitTouched] = useState(false);

  // Cold-start personalization. Goal is required; everything else is
  // skippable so a hesitant user is never stuck on the body inputs.
  const [goal, setGoal] = useState<Goal | null>(null);
  // Where the user trains. Always has a value — defaults to Gym, same
  // default submitWith used to hardcode before this became a UI choice.
  const [location, setLocation] = useState<OnboardingLocation>('Gym');
  const [bodyweightInput, setBodyweightInput] = useState<string>('');
  const [sex, setSex] = useState<Sex | null>(null);
  // Anchor-lift numbers ("what are you lifting these days?") — every row
  // independently optional. Raw text state (mirrors bodyweightInput);
  // parsed + validated per-row at submit time via parseAnchorEntry so a
  // half-typed row never blocks the others.
  const [anchorInputs, setAnchorInputs] = useState(emptyAnchorInputs());
  const setAnchorField = (key: AnchorLiftKey, field: 'weight' | 'reps', value: string) => {
    setAnchorInputs(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Pager step. `step` mirrors the pager's currently-visible page. The pager
  // is the source of truth on user swipe; setPage() drives it back from
  // Back/Next taps.
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const pagerRef = useRef<PagerView>(null);

  // Parse the bodyweight text input. Decimal-tolerant (the field accepts a
  // comma OR a dot — easier for EU users). Anything outside the plausible
  // range or unparseable returns null, which the seed helper treats as
  // "user skipped" → no fake number.
  const parseBodyweight = (raw: string): number | null => {
    const normalized = raw.replace(',', '.').trim();
    if (!normalized) return null;
    const n = Number(normalized);
    if (!Number.isFinite(n)) return null;
    if (n < BODYWEIGHT_MIN_KG || n > BODYWEIGHT_MAX_KG) return null;
    return Math.round(n * 100) / 100;
  };

  // Toggle a weekday in/out of the selection. Capped at MAX_WEEKDAYS (a
  // tap that would push over the cap is dropped silently — the count
  // hint below the picker explains the bound). Below MIN_WEEKDAYS the
  // submit button is disabled; we don't auto-reject mid-selection.
  const toggleWeekday = (w: number) => {
    setWeekdays(prev => {
      const next = prev.includes(w) ? prev.filter(x => x !== w) : [...prev, w].sort((a, b) => a - b);
      if (next.length > MAX_WEEKDAYS) return prev;
      // Re-default the split when the user hasn't expressed a preference,
      // mirroring the prior "days nudges split" behavior.
      if (!splitTouched) setSplit(splitForDays(next.length));
      return next;
    });
  };

  const clusteredNote = hasConsecutiveRun(weekdays, 3)
    ? 'Heads-up: three or more days in a row can leave little time to recover. Spread them out if you can.'
    : null;

  // Fire onboarding_started once per mount. The funnel needs a "started"
  // edge to measure drop-off vs. onboarding_completed; without it we only
  // see who finished, not who bailed. Ref-guarded so React's strict-mode
  // double-mount and any sub-tree re-renders don't double-count.
  const onboardingStartedFired = useRef(false);
  useEffect(() => {
    if (onboardingStartedFired.current) return;
    onboardingStartedFired.current = true;
    track('onboarding_started');
  }, []);

  // `level` + `goal` are required; weekday count must be in [MIN_WEEKDAYS, MAX_WEEKDAYS].
  // location always has a default (Gym); bodyweight, sex, and every anchor
  // row are optional — skipping any of them collapses the seed back to a
  // calibration entry on session 1, which is a valid path. Goal is the
  // only NEW required field because every coach rationale line
  // specializes on it.
  const isValid =
    level !== null &&
    goal !== null &&
    weekdays.length >= MIN_WEEKDAYS &&
    weekdays.length <= MAX_WEEKDAYS;

  // Human-readable hint for the disabled Start-training button on step 3.
  // Non-blocking guide only — the user can swipe back to fix whatever's
  // missing; no per-step gate on the pager itself.
  const missingHint = (): string | null => {
    if (isValid) return null;
    const missing: string[] = [];
    if (level === null) missing.push('training experience');
    if (weekdays.length < MIN_WEEKDAYS) missing.push('training days');
    if (goal === null) missing.push('a goal');
    if (missing.length === 0) return null;
    return `Swipe back and pick ${missing.join(', ')}.`;
  };

  // Show the split-mismatch prompt and proceed with whichever option the
  // user picks. The actual persistence + plan-gen lives in submitWith(),
  // so both paths funnel into one code path; the dialog only chooses
  // which split value to pass.
  const handleSubmit = () => {
    if (!isValid || submitting) return;

    const recommended = splitForDays(days);
    if (split === recommended) {
      void submitWith(split);
      return;
    }

    // Soft guardrail: a bro_split user who picked 3 days will structurally
    // never reach arms/legs with the historical generator unless they bump
    // to 5+ days/week or switch to PPL. We steer to PPL but never block —
    // the user's choice still wins if they tap "Keep my choice".
    const recommendedLabel = SPLIT_OPTIONS.find(s => s.value === recommended)?.label ?? recommended;
    const chosenLabel = SPLIT_OPTIONS.find(s => s.value === split)?.label ?? split;
    Alert.alert(
      'Quick check',
      `For ${days} days a week, ${recommendedLabel} trains every muscle group more evenly than ${chosenLabel}. Use ${recommendedLabel}?`,
      [
        {
          text: `Use ${recommendedLabel}`,
          onPress: () => {
            setSplit(recommended);
            setSplitTouched(true);
            void submitWith(recommended);
          },
        },
        {
          text: 'Keep my choice',
          style: 'cancel',
          onPress: () => void submitWith(split),
        },
      ],
    );
  };

  const submitWith = async (chosenSplit: SplitId) => {
    if (submitting) return;
    setErrorMsg('');
    setSubmitting(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setErrorMsg('Session lost. Please sign in again.');
        setSubmitting(false);
        return;
      }

      // 1. Persist the minimum profile. Username is intentionally absent —
      //    home.tsx falls back to "Athlete" until the user back-fills via
      //    the Profile tab. onboarding_complete flips true here because the
      //    user has provided everything the engine actually needs.
      //    preferred_split is the user's CHOSEN split (authoritative), not a
      //    function of the day count.
      // Bodyweight + sex are only persisted when the user actually entered
      // them. An empty / invalid bodyweight stays NULL in the row, which is
      // exactly what the seed helper reads as "user skipped → no seed".
      const bodyweightKg = parseBodyweight(bodyweightInput);
      const { error: profileErr } = await supabase.from('profiles').upsert({
        id: user.id,
        training_days: days,
        preferred_split: chosenSplit,
        fitness_level: level,
        // The picker is the source of truth for which calendar days the
        // plan schedules sessions on; training_days is just its length.
        training_weekdays: weekdays,
        // Cold-start personalization. Goal is required. Bodyweight/sex are
        // skippable — passing null preserves the existing NULL in the row.
        // priority is always null now — the chip step was removed; every
        // downstream reader already treats null as "no priority set".
        goal,
        priority: null,
        bodyweight_kg: bodyweightKg,
        sex: sex ?? null,
        onboarding_complete: true,
      });
      if (profileErr) throw profileErr;

      // 2. Persist the location choice BEFORE plan gen — ensureCurrentWeekPlan
      //    reads this key when assembling the exercise pool. Now a step-2 UI
      //    choice instead of a hardcoded Gym default; still editable later
      //    from the Profile tab.
      await AsyncStorage.setItem('user:defaultLocation', location);

      // 2b. Mirror the plan-shaping inputs into the offline cache so plan
      //    regen / self-heal still work without a network read. Supabase stays
      //    the source of truth; this is the last-known-good fallback (same
      //    model as plan:current / user:defaultLocation). Fire-and-forget.
      await writeCachedProfileInputs({
        training_days: days,
        preferred_split: chosenSplit,
        fitness_level: level,
        training_weekdays: weekdays,
        goal,
      });

      // 2c. Optional anchor-lift seed ("what are you lifting these days?").
      //    Converts whatever rows the user filled in into REAL exercise_logs
      //    history — NOT a workout_sessions row, this is history only, so it
      //    can never inflate a completed-session count or rotation phase.
      //    Every row is independently optional; parseAnchorEntry drops
      //    anything blank/unparseable, so a totally empty step produces zero
      //    rows and is a silent no-op. Best-effort: a write failure here
      //    must never block onboarding — worst case, session one falls back
      //    to the calibration line, same as if the user had skipped this
      //    step outright. The AsyncStorage note write is what lets the
      //    Coach's Call say "based on your 100×5" the first time it prices
      //    the lift — see anchorSeed usage in app/workout.tsx.
      let anchorSeedCount = 0;
      try {
        const todayIso = (() => {
          const d = new Date();
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        const anchors: Partial<Record<AnchorLiftKey, AnchorEntry | null>> = {};
        for (const def of ANCHOR_LIFTS) {
          anchors[def.key] = parseAnchorEntry(anchorInputs[def.key].weight, anchorInputs[def.key].reps);
        }
        const { rows, notes } = buildAnchorSeedRows({ anchors, todayIso });
        anchorSeedCount = rows.length;
        if (rows.length > 0) {
          const { error: seedErr } = await supabase.from('exercise_logs').insert(
            rows.map(r => ({ ...r, user_id: user.id, session_id: null })),
          );
          if (seedErr) throw seedErr;
          await AsyncStorage.setItem(ANCHOR_SEED_NOTES_STORAGE_KEY, JSON.stringify(notes));
        }
      } catch (e) {
        reportSilent(e, 'onboarding:seedAnchorLifts');
      }

      // 3. Generate + persist the first weekly plan. force:true skips the
      //    "does a plan already exist" check; on a fresh user it's a no-op
      //    distinction, but it makes intent obvious if onboarding is re-run.
      //    Reuse the shared helper — do NOT duplicate plan-gen here.
      const planDays = await ensureCurrentWeekPlan({ force: true });

      track('onboarding_completed', {
        training_days: days,
        goal,
        location,
        has_bodyweight: bodyweightKg != null,
        sex: sex ?? 'unset',
        anchor_seed_count: anchorSeedCount,
      });

      // Default-on reminders: prompt for permission once, save 18:00 as the
      // default time, and schedule against the plan we just generated. The
      // util is no-op on subsequent runs (asked-flag) and in Expo Go.
      await enableNotificationsIfFirstTime();

      // Activation: route the new user straight into the workout pre-screen
      // for today's session instead of the dashboard. The pre-screen has the
      // "Start Workout" CTA — we don't auto-start, we just shorten the path
      // from "signed up" to "tap to begin."
      //
      // Day selection: workout.tsx can only load TODAY (no day-override
      // param), so the safe routing is "go to /workout iff today has a
      // planned session." Otherwise fall back to /(tabs)/home where the
      // user sees today's rest-day card with the next workout label, not a
      // "Rest day" error screen.
      //
      // For brand-new accounts this branch is essentially always 'workout'
      // because pickDefaultDayOffsets() starts with offset 0 (today) for
      // every training-day count — but the guard is cheap and protects
      // re-onboarding flows or future changes to that helper.
      const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      const todayIsPlanned = !!planDays && planDays.some(d => d.day === todayName);

      // Matches the Dashboard's "Start workout" button: router.push('/workout')
      // with no params. workout.tsx derives "today" from the local Date.
      // We use replace (not push) so the back gesture doesn't return to
      // onboarding.
      router.replace(todayIsPlanned ? '/workout' : '/(tabs)/home');
    } catch (e: any) {
      console.error('Onboarding error:', e);
      setErrorMsg(e?.message ?? 'Something went wrong. Try again.');
      setSubmitting(false);
    }
  };

  // Programmatic pager navigation. `setPage` triggers `onPageSelected` on
  // the native pager, which in turn updates `step` — one source of truth.
  const goBack = () => {
    if (step === 0 || submitting) return;
    pagerRef.current?.setPage(step - 1);
  };
  const goNext = () => {
    if (submitting) return;
    if (step < TOTAL_STEPS - 1) {
      pagerRef.current?.setPage(step + 1);
    } else {
      handleSubmit();
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header: brand + progress dots. Fixed above the pager so the
            step indicator doesn't scroll with page content. */}
        <View style={styles.header}>
          <Text style={styles.brand}>INTR</Text>
          <View style={styles.progressRow} accessibilityLabel={`Step ${step + 1} of ${TOTAL_STEPS}`}>
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.progressPill,
                  i === step && styles.progressPillActive,
                  i < step && styles.progressPillDone,
                ]}
              />
            ))}
          </View>
        </View>

        <PagerView
          ref={pagerRef}
          style={{ flex: 1 }}
          initialPage={0}
          onPageSelected={e => setStep(e.nativeEvent.position as 0 | 1 | 2)}
          // Preserve scroll behavior on native swipe; disabling swipe would
          // add a gate the pre-paged layout didn't have.
        >
          {/* ── Step 1: training schedule (level + weekdays + split) ── */}
          <View key="step-1" style={styles.page}>
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.intro}>
                Three answers. Your first workout is ready in seconds.
              </Text>

              {/* Fitness level */}
              <Text style={styles.label}>How long have you trained?</Text>
              <View style={styles.levelRow}>
                {LEVELS.map(opt => {
                  const selected = level === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.levelChip, selected && styles.levelChipActive]}
                      onPress={() => setLevel(opt.value)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.levelLabel, selected && styles.levelLabelActive]}>{opt.label}</Text>
                      <Text style={[styles.levelHint, selected && styles.levelHintActive]}>{opt.hint}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Weekday picker. The number of selected weekdays IS the
                  training-days count — splitForDays(days) uses the same count. */}
              <Text style={[styles.label, { marginTop: layout.spacing.xl }]}>Which days can you train?</Text>
              <View style={styles.daysRow}>
                {WEEKDAY_LAYOUT.map(opt => {
                  const selected = weekdays.includes(opt.value);
                  const atCap = !selected && weekdays.length >= MAX_WEEKDAYS;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        styles.dayPill,
                        selected && styles.dayPillActive,
                        atCap && { opacity: 0.4 },
                      ]}
                      onPress={() => toggleWeekday(opt.value)}
                      disabled={atCap}
                      activeOpacity={0.8}
                      accessibilityLabel={`Toggle ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][opt.value]}`}
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.dayText, selected && styles.dayTextActive]}>{opt.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={styles.deferNote}>
                {weekdays.length === 0
                  ? `Pick ${MIN_WEEKDAYS}–${MAX_WEEKDAYS} days.`
                  : weekdays.length < MIN_WEEKDAYS
                    ? `Pick ${MIN_WEEKDAYS - weekdays.length} more — at least ${MIN_WEEKDAYS} days a week.`
                    : `${weekdays.length} day${weekdays.length === 1 ? '' : 's'} a week.`}
              </Text>
              {clusteredNote && (
                <Text style={[styles.deferNote, { color: colors.accentAmber }]}>
                  {clusteredNote}
                </Text>
              )}

              {/* Workout split */}
              <Text style={[styles.label, { marginTop: layout.spacing.xl }]}>Which split do you want?</Text>
              <View style={styles.splitList}>
                {SPLIT_OPTIONS.map(opt => {
                  const selected = split === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.splitCard, selected && styles.splitCardActive]}
                      onPress={() => { setSplit(opt.value); setSplitTouched(true); }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.splitLabel, selected && styles.splitLabelActive]}>{opt.label}</Text>
                      <Text style={[styles.splitDesc, selected && styles.splitDescActive]}>{opt.desc}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          {/* ── Step 2: goal + where you train + optional body inputs ── */}
          <View key="step-2" style={styles.page}>
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Goal — required. Drives the cold-start coach rationale ("built
                  around getting your bench moving") and later, volume biasing. */}
              <Text style={styles.label}>What are you here for?</Text>
              <View style={styles.levelRow}>
                {GOAL_OPTIONS.map(opt => {
                  const selected = goal === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.levelChip, selected && styles.levelChipActive]}
                      onPress={() => setGoal(opt.value)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.levelLabel, selected && styles.levelLabelActive]}>{opt.label}</Text>
                      <Text style={[styles.levelHint, selected && styles.levelHintActive]} numberOfLines={1}>{opt.desc}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Where you train — sets user:defaultLocation, which the
                  exercise pool reads at plan-gen time. Always has a value
                  (defaults to Gym); not part of isValid because a sensible
                  default already covers a skip-equivalent tap-through. */}
              <Text style={[styles.label, { marginTop: layout.spacing.xl }]}>Where do you train?</Text>
              <View style={styles.levelRow}>
                {LOCATION_OPTIONS.map(opt => {
                  const selected = location === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.levelChip, selected && styles.levelChipActive]}
                      onPress={() => setLocation(opt.value)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.levelLabel, selected && styles.levelLabelActive]}>{opt.label}</Text>
                      <Text style={[styles.levelHint, selected && styles.levelHintActive]} numberOfLines={1}>{opt.hint}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Bodyweight + sex — both optional. Framed functionally so the
                  user knows WHY we're asking; skipping is fine and just means
                  session 1 stays a calibration entry instead of a seeded one. */}
              <Text style={[styles.label, { marginTop: layout.spacing.xl }]}>
                Bodyweight (optional)
              </Text>
              <Text style={styles.helperNote}>
                Lets us seed sensible starting weights. Skip and session one becomes a quick calibration set.
              </Text>
              <View style={styles.bodyRow}>
                <View style={styles.bodyInputWrap}>
                  <TextInput
                    style={styles.bodyInput}
                    value={bodyweightInput}
                    onChangeText={setBodyweightInput}
                    placeholder="—"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    maxLength={6}
                    accessibilityLabel="Bodyweight in kilograms"
                  />
                  <Text style={styles.bodyUnit}>kg</Text>
                </View>
                <View style={styles.sexRow}>
                  {SEX_OPTIONS.map(opt => {
                    const selected = sex === opt.value;
                    return (
                      <TouchableOpacity
                        key={opt.value}
                        style={[styles.sexChip, selected && styles.sexChipActive]}
                        onPress={() => setSex(prev => (prev === opt.value ? null : opt.value))}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.sexChipText, selected && styles.sexChipTextActive]}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </ScrollView>
          </View>

          {/* ── Step 3: anchor-lift numbers (fully optional) + Start training ──
              "What are you lifting these days?" — a near-max effort per
              compound (e.g. "100kg x 5"), NOT a working-set number. The
              app converts it into a real seeded session so session one's
              Coach's Call shows a credible working weight for the plan's
              actual rep range instead of the bare "we'll find your weight
              as you go" line. Every row is independently optional; the
              whole step is skippable via Next/Skip — isValid never reads
              these fields. This is the LAST page: the footer CTA reads
              "Start training" here and missingHint/errorMsg surface below
              the anchor rows. */}
          <View key="step-3" style={styles.page}>
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.label}>
                What are you lifting these days? (optional)
              </Text>
              <Text style={styles.helperNote}>
                A recent set for any of these — makes your first session accurate. Skip any (or all) you don&apos;t know.
              </Text>

              <View style={styles.anchorHeaderRow}>
                <Text style={[styles.anchorHeaderCell, { flex: 1.4 }]} />
                <Text style={styles.anchorHeaderCell}>kg</Text>
                <Text style={styles.anchorHeaderCell}>reps</Text>
              </View>
              {ANCHOR_LIFTS.map(def => (
                <View key={def.key} style={styles.anchorRow}>
                  <Text style={styles.anchorLabel} numberOfLines={1}>{def.label}</Text>
                  <TextInput
                    style={styles.anchorInput}
                    value={anchorInputs[def.key].weight}
                    onChangeText={v => setAnchorField(def.key, 'weight', v)}
                    placeholder="—"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    maxLength={6}
                    accessibilityLabel={`${def.label} weight in kilograms`}
                  />
                  <TextInput
                    style={styles.anchorInput}
                    value={anchorInputs[def.key].reps}
                    onChangeText={v => setAnchorField(def.key, 'reps', v)}
                    placeholder="—"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="number-pad"
                    maxLength={2}
                    accessibilityLabel={`${def.label} reps`}
                  />
                </View>
              ))}

              {/* Explicit skip affordance — functionally identical to
                  leaving every row blank and tapping Next, but "Skip" as
                  a first-class choice matters more here than on the other
                  optional steps: this one has ten empty boxes staring
                  back, and a lifter who doesn't know their numbers off
                  the top of their head should feel invited to move on,
                  not stuck. */}
              <TouchableOpacity
                onPress={goNext}
                activeOpacity={0.7}
                style={styles.anchorSkipLink}
                accessibilityLabel="Skip this step"
              >
                <Text style={styles.anchorSkipLinkText}>Skip — I&apos;ll figure it out as I go</Text>
              </TouchableOpacity>

              {/* Import placeholder — the real importer (Strong, Hevy, etc.)
                  isn't built yet. Rather than a dead tap, it's honest about
                  that: a visually secondary button (outline, not filled —
                  Start training stays the one primary action on this page)
                  that opens a "coming soon" notice. */}
              <TouchableOpacity
                onPress={() => Alert.alert(
                  'Coming soon',
                  'Import from Strong, Hevy and others — coming soon.',
                )}
                activeOpacity={0.7}
                style={styles.importBtn}
                accessibilityLabel="Import from another app"
              >
                <Text style={styles.importBtnText}>Import from another app</Text>
              </TouchableOpacity>

              {/* Hint when the Start-training button is disabled — points
                  the user back to the earlier step(s) that still need
                  filling. Non-blocking: they swipe back themselves. */}
              {(() => {
                const hint = missingHint();
                return hint ? <Text style={styles.missingHint}>{hint}</Text> : null;
              })()}

              {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}
            </ScrollView>
          </View>
        </PagerView>

        {/* Footer: Back on the left (hidden on step 1), Next / Start on
            the right. Next advances one page; on the last step it becomes
            the Start-training button — the SAME handleSubmit that gates
            on isValid and runs submitWith. */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.backBtn, step === 0 && styles.backBtnHidden]}
            onPress={goBack}
            disabled={step === 0 || submitting}
            activeOpacity={0.7}
            accessibilityLabel="Back"
          >
            <Text style={styles.backBtnText}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.cta,
              step === TOTAL_STEPS - 1 && !isValid && styles.ctaDisabled,
            ]}
            onPress={goNext}
            disabled={
              submitting || (step === TOTAL_STEPS - 1 && !isValid)
            }
            activeOpacity={0.85}
          >
            <Text style={styles.ctaText}>
              {step < TOTAL_STEPS - 1
                ? 'Next'
                : submitting
                  ? 'Building your first week…'
                  : 'Start training'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: layout.spacing.lg,
    paddingTop: layout.spacing.lg,
    paddingBottom: layout.spacing.md,
    alignItems: 'center',
  },
  brand: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    color: colors.textPrimary,
    letterSpacing: 6,
    textAlign: 'center',
    marginBottom: layout.spacing.md,
  },
  // 3-pill progress indicator. Active step gets the teal fill; earlier
  // (done) steps get a subtler fill so the user reads them as complete
  // vs. current at a glance.
  progressRow: {
    flexDirection: 'row',
    gap: 8,
  },
  progressPill: {
    width: 34,
    height: 4,
    borderRadius: layout.pillRadius,
    backgroundColor: colors.surfaceElevated,
  },
  progressPillActive: {
    backgroundColor: colors.accentTeal,
  },
  progressPillDone: {
    backgroundColor: colors.accentTeal,
    opacity: 0.5,
  },
  page: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: layout.spacing.lg,
    paddingTop: layout.spacing.md,
    paddingBottom: layout.spacing.xxl,
  },
  intro: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
    paddingHorizontal: layout.spacing.lg,
    marginBottom: layout.spacing.xxl,
  },
  label: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s14,
    color: colors.textSecondary,
    marginBottom: layout.spacing.sm,
  },
  levelRow: {
    flexDirection: 'row',
    gap: 8,
  },
  levelChip: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  levelChipActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.surfaceElevated,
  },
  levelLabel: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s13,
    color: colors.textPrimary,
  },
  levelLabelActive: {
    color: colors.accentTeal,
  },
  levelHint: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    letterSpacing: 1,
    color: colors.textMuted,
    marginTop: 2,
  },
  levelHintActive: {
    color: colors.accentTeal,
  },
  daysRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dayPill: {
    flex: 1,
    height: 56,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayPillActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.surfaceElevated,
  },
  dayText: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    color: colors.textPrimary,
  },
  dayTextActive: {
    color: colors.accentTeal,
  },
  splitList: {
    gap: 8,
  },
  splitCard: {
    paddingVertical: 14,
    paddingHorizontal: layout.spacing.md,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
  },
  splitCardActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.surfaceElevated,
  },
  splitLabel: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.md,
    color: colors.textPrimary,
  },
  splitLabelActive: {
    color: colors.accentTeal,
  },
  splitDesc: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    color: colors.textMuted,
    marginTop: 3,
    lineHeight: 16,
  },
  splitDescActive: {
    color: colors.textSecondary,
  },
  deferNote: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: layout.spacing.xl,
    paddingHorizontal: layout.spacing.md,
    lineHeight: 17,
  },
  helperNote: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    color: colors.textMuted,
    marginTop: -layout.spacing.xs,
    marginBottom: layout.spacing.sm,
    lineHeight: 16,
  },
  anchorHeaderRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: layout.spacing.md,
    paddingHorizontal: 2,
  },
  anchorHeaderCell: {
    flex: 1,
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    letterSpacing: 1,
    color: colors.textMuted,
    textAlign: 'center',
  },
  anchorRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  anchorLabel: {
    flex: 1.4,
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s13,
    color: colors.textPrimary,
  },
  anchorInput: {
    flex: 1,
    height: 48,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  anchorSkipLink: {
    alignSelf: 'center',
    marginTop: layout.spacing.lg,
    padding: layout.spacing.sm,
  },
  anchorSkipLinkText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s13,
    color: colors.textMuted,
    textDecorationLine: 'underline',
  },
  importBtn: {
    height: 48,
    marginTop: layout.spacing.lg,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importBtnText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s13,
    color: colors.textSecondary,
  },
  bodyRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'stretch',
  },
  bodyInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.spacing.md,
    height: 56,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
  },
  bodyInput: {
    flex: 1,
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    color: colors.textPrimary,
    padding: 0,
  },
  bodyUnit: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s13,
    color: colors.textMuted,
    marginLeft: 6,
  },
  sexRow: {
    flexDirection: 'row',
    gap: 6,
    flex: 1.2,
  },
  sexChip: {
    flex: 1,
    minWidth: 36,
    paddingHorizontal: 8,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sexChipActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.surfaceElevated,
  },
  sexChipText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s12,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  sexChipTextActive: {
    color: colors.accentTeal,
  },
  missingHint: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    color: colors.accentAmber,
    marginTop: layout.spacing.md,
    textAlign: 'center',
    lineHeight: 17,
  },
  errorText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.accentCoral,
    marginTop: layout.spacing.md,
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: layout.spacing.sm,
    paddingHorizontal: layout.spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? layout.spacing.xl : layout.spacing.lg,
    paddingTop: layout.spacing.md,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  backBtn: {
    height: 52,
    paddingHorizontal: layout.spacing.lg,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Hidden but preserved in the flex row so the CTA stays in the same
  // spot regardless of step (no layout shift between step 1 and step 2).
  backBtnHidden: {
    opacity: 0,
  },
  backBtnText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.sm,
    color: colors.textSecondary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  cta: {
    flex: 1,
    height: 52,
    borderRadius: layout.cardRadius,
    backgroundColor: colors.accentTeal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaDisabled: {
    backgroundColor: colors.surfaceElevated,
  },
  ctaText: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    color: colors.background,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
