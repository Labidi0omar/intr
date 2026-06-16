import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
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

// Three taps to a real first workout.
// We intentionally collect ONLY the minimum needed to generate a plan:
//   - fitness level   (training intensity / exercise pool)
//   - training days   (frequency)
//   - workout split   (which muscles land on which day)
// Location (gym vs home) is NOT asked here — it defaults to gym and is
// editable from the Profile tab, so onboarding stays short. Username and
// other profile fields are back-fillable from Profile too — never block
// activation on them. Defaults: days=3, split=splitForDays(3), location=gym.

const DAYS_OPTIONS = [2, 3, 4, 5, 6];
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

export default function OnboardingScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();

  const [level, setLevel] = useState<FitnessLevel | null>(null);
  const [days, setDays] = useState(3);
  // Split is pre-selected from the day count as a sensible default, but the
  // user's pick is authoritative. `splitTouched` stops the days-driven default
  // from overriding an explicit choice.
  const [split, setSplit] = useState<SplitId>(splitForDays(3));
  const [splitTouched, setSplitTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Changing days nudges the default split — until the user has picked one.
  const handleDaysChange = (d: number) => {
    setDays(d);
    if (!splitTouched) setSplit(splitForDays(d));
  };

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

  // Only `level` is truly required from the user; the other two have sane
  // defaults so a one-tap-plus-CTA path works.
  const isValid = level !== null;

  const handleSubmit = async () => {
    if (!isValid || submitting) return;
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
      const { error: profileErr } = await supabase.from('profiles').upsert({
        id: user.id,
        training_days: days,
        preferred_split: split,
        fitness_level: level,
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
        preferred_split: split,
        fitness_level: level,
      });

      // 3. Generate + persist the first weekly plan. force:true skips the
      //    "does a plan already exist" check; on a fresh user it's a no-op
      //    distinction, but it makes intent obvious if onboarding is re-run.
      //    Reuse the shared helper — do NOT duplicate plan-gen here.
      const planDays = await ensureCurrentWeekPlan({ force: true });

      track('onboarding_completed', { training_days: days });

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

          {/* Days per week */}
          <Text style={[styles.label, { marginTop: layout.spacing.xl }]}>How many days a week?</Text>
          <View style={styles.daysRow}>
            {DAYS_OPTIONS.map(d => {
              const selected = days === d;
              return (
                <TouchableOpacity
                  key={d}
                  style={[styles.dayPill, selected && styles.dayPillActive]}
                  onPress={() => handleDaysChange(d)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.dayText, selected && styles.dayTextActive]}>{d}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

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
    fontSize: 14,
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
    fontSize: 13,
    color: colors.textPrimary,
  },
  levelLabelActive: {
    color: colors.accentTeal,
  },
  levelHint: {
    fontFamily: typography.family.body,
    fontSize: 10,
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
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 3,
    lineHeight: 16,
  },
  splitDescActive: {
    color: colors.textSecondary,
  },
  deferNote: {
    fontFamily: typography.family.body,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: layout.spacing.xl,
    paddingHorizontal: layout.spacing.md,
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
