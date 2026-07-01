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
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../src/context/ThemeContext';
import { supabase } from '../src/lib/supabase';
import { track } from '../src/lib/analytics';
import { splitForDays, type FitnessLevel, type SplitId } from '../src/lib/planGeneration';
import { ensureCurrentWeekPlan, writeCachedProfileInputs } from '../src/lib/planSync';
import { enableNotificationsIfFirstTime } from '../src/utils/notifications';
import { layout, typography } from '../src/theme';
import { hasConsecutiveRun } from '../src/utils/trainingWeekdays';

// Three taps to a real first workout.
// We intentionally collect ONLY the minimum needed to generate a plan:
//   - fitness level   (training intensity / exercise pool)
//   - training days   (frequency)
//   - workout split   (which muscles land on which day)
// Location (gym vs home) is NOT asked here — it defaults to gym and is
// editable from the Profile tab, so onboarding stays short. Username and
// other profile fields are back-fillable from Profile too — never block
// activation on them. Defaults: days=3, split=splitForDays(3), location=gym.

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

// Priority — optional. The user picks one area / lift to flag as the thing
// they most want to move. Map to muscle filter buckets we already use OR a
// key compound (the seed helper recognises the same names). 'none' is a
// real, non-judgmental answer; stored as NULL.
type Priority =
  | 'chest' | 'back' | 'shoulders' | 'arms' | 'legs'
  | 'bench' | 'squat' | 'deadlift';
const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'chest', label: 'Chest' },
  { value: 'back', label: 'Back' },
  { value: 'shoulders', label: 'Shoulders' },
  { value: 'arms', label: 'Arms' },
  { value: 'legs', label: 'Legs' },
  { value: 'bench', label: 'Bench' },
  { value: 'squat', label: 'Squat' },
  { value: 'deadlift', label: 'Deadlift' },
];

type Sex = 'male' | 'female' | 'unspecified';
const SEX_OPTIONS: { value: Sex; label: string }[] = [
  { value: 'male', label: 'M' },
  { value: 'female', label: 'F' },
  { value: 'unspecified', label: 'Rather not say' },
];

// Bodyweight bounds match the migration's CHECK so a value the DB will accept
// is the same set the UI lets through. Anything outside this range gets
// quietly dropped before submit (not surfaced as an error — the field is
// skippable; an unparseable input simply means "no seed").
const BODYWEIGHT_MIN_KG = 25;
const BODYWEIGHT_MAX_KG = 300;

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
  const [priority, setPriority] = useState<Priority | null>(null);
  const [bodyweightInput, setBodyweightInput] = useState<string>('');
  const [sex, setSex] = useState<Sex | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

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
  // priority, bodyweight, and sex are all optional — skipping any of them
  // collapses the seed back to a calibration entry on session 1, which is a
  // valid path. Goal is the only NEW required field because every coach
  // rationale line specializes on it.
  const isValid =
    level !== null &&
    goal !== null &&
    weekdays.length >= MIN_WEEKDAYS &&
    weekdays.length <= MAX_WEEKDAYS;

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
        // Cold-start personalization. Goal is required. The other three are
        // skippable — passing null preserves the existing NULL in the row.
        goal,
        priority: priority ?? null,
        bodyweight_kg: bodyweightKg,
        sex: sex ?? null,
        onboarding_complete: true,
      });
      if (profileErr) throw profileErr;

      // 2. Default the location to Gym BEFORE plan gen — ensureCurrentWeekPlan
      //    reads this key when assembling the exercise pool. We no longer ask
      //    for it in onboarding; the user can switch to Home from Profile.
      await AsyncStorage.setItem('user:defaultLocation', 'Gym');

      // 2b. Mirror the plan-shaping inputs into the offline cache so plan
      //    regen / self-heal still work without a network read. Supabase stays
      //    the source of truth; this is the last-known-good fallback (same
      //    model as plan:current / user:defaultLocation). Fire-and-forget.
      await writeCachedProfileInputs({
        training_days: days,
        preferred_split: chosenSplit,
        fitness_level: level,
        training_weekdays: weekdays,
      });

      // 3. Generate + persist the first weekly plan. force:true skips the
      //    "does a plan already exist" check; on a fresh user it's a no-op
      //    distinction, but it makes intent obvious if onboarding is re-run.
      //    Reuse the shared helper — do NOT duplicate plan-gen here.
      const planDays = await ensureCurrentWeekPlan({ force: true });

      track('onboarding_completed', {
        training_days: days,
        goal,
        priority: priority ?? 'none',
        has_bodyweight: bodyweightKg != null,
        sex: sex ?? 'unset',
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.brand}>INTR</Text>
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

          {/* Goal — required. Drives the cold-start coach rationale ("built
              around getting your bench moving") and later, volume biasing. */}
          <Text style={[styles.label, { marginTop: layout.spacing.xl }]}>What are you here for?</Text>
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

          {/* Priority — optional. One area or lift the user most wants to
              move. A second tap on the same chip unselects (== "no preference"). */}
          <Text style={[styles.label, { marginTop: layout.spacing.xl }]}>Anything you want to push? (optional)</Text>
          <View style={styles.priorityWrap}>
            {PRIORITY_OPTIONS.map(opt => {
              const selected = priority === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.priorityChip, selected && styles.priorityChipActive]}
                  onPress={() => setPriority(prev => (prev === opt.value ? null : opt.value))}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.priorityChipText, selected && styles.priorityChipTextActive]}>{opt.label}</Text>
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

          <Text style={styles.deferNote}>
            Train at home? Set your gym/home and other details from the Profile tab later.
          </Text>

          {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.cta, !isValid && styles.ctaDisabled]}
            onPress={handleSubmit}
            disabled={!isValid || submitting}
            activeOpacity={0.85}
          >
            <Text style={styles.ctaText}>{submitting ? 'Building your first week…' : 'Start training'}</Text>
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
  scrollContent: {
    paddingHorizontal: layout.spacing.lg,
    paddingTop: layout.spacing.xl,
    paddingBottom: layout.spacing.xxl,
  },
  brand: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    color: colors.textPrimary,
    letterSpacing: 6,
    textAlign: 'center',
    marginBottom: layout.spacing.md,
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
  priorityWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  priorityChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
  },
  priorityChipActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.surfaceElevated,
  },
  priorityChipText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s13,
    color: colors.textPrimary,
  },
  priorityChipTextActive: {
    color: colors.accentTeal,
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
  errorText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.accentCoral,
    marginTop: layout.spacing.md,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: layout.spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? layout.spacing.xl : layout.spacing.lg,
    paddingTop: layout.spacing.md,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  cta: {
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
