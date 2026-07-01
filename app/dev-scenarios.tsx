// Dev-only "seeded state" menu. Lists every scenario in
// src/lib/devScenarios.ts; tapping one wipes the current account and
// seeds it via devSeed.ts so the REAL read paths are exercised against
// known states. Hard-gated by __DEV__: production builds render a
// "not available" notice instead of any wipe affordance, and the only
// way to reach this route at all is the __DEV__-gated long-press on
// the Profile username (matching the Sentry smoke-test gating pattern
// in app/(tabs)/home.tsx).
//
// Safety: every action runs through a LOUD confirm dialog warning that
// this is a dev/test account and the operation is destructive. The
// dialog text is intentionally non-cute — this is a footgun and the
// copy should read like one.

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../src/context/ThemeContext';
import { layout, typography } from '../src/theme';
import { listScenarios, type ScenarioId } from '../src/lib/devScenarios';
import { seedScenario, wipeToFreshAccount, type SeedResult } from '../src/lib/devSeed';

export default function DevScenariosScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();

  // Production guard. Even though the route is registered for both
  // builds (so Expo Router's static analysis stays happy), the screen
  // body short-circuits to a plain notice in a release build. Anyone
  // who reaches the URL out-of-band lands on the notice — never on
  // the wipe buttons.
  if (!__DEV__) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.notAvailable}>
          <Text style={styles.notAvailableText}>Not available in this build.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SeedResult | null>(null);

  // Show the loud confirm dialog. The actual seed runs in `onConfirm`.
  const confirmAndRun = (title: string, body: string, onConfirm: () => Promise<void>) => {
    Alert.alert(
      title,
      body,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Wipe & seed', style: 'destructive', onPress: () => void onConfirm() },
      ],
      { cancelable: true },
    );
  };

  const runSeed = async (id: ScenarioId, label: string) => {
    if (busyId) return;
    setBusyId(id);
    setLastResult(null);
    try {
      const result = await seedScenario(id);
      setLastResult(result);
      if (result.ok) {
        // Route to home so the user sees the seeded state immediately on
        // the dashboard read paths. replace() so back-gesture doesn't
        // bounce back to the dev menu.
        router.replace('/(tabs)/home');
      }
    } finally {
      setBusyId(null);
    }
    // void label — currently unused; kept in the signature so adding a
    // confirm-dialog-message that quotes the label later is a one-liner.
    void label;
  };

  const runWipe = async () => {
    if (busyId) return;
    setBusyId('wipe');
    setLastResult(null);
    try {
      const result = await wipeToFreshAccount();
      setLastResult(result);
      if (result.ok) {
        // Send the user back to the session guard so the empty profile
        // routes them through onboarding cleanly.
        router.replace('/');
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.6}>
            <Text style={styles.backChevron}>‹  Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>DEV SCENARIOS</Text>
          <Text style={styles.warning}>
            Dev/test accounts only. Every action below WIPES this account&apos;s
            sessions, exercise logs, weekly plan, and history-derived caches
            before seeding. Never tap these on a real user.
          </Text>
        </View>

        {lastResult && (
          <View style={[styles.resultCard, { borderColor: lastResult.ok ? colors.accentTeal : colors.accentCoral }]}>
            <Text style={styles.resultSummary}>{lastResult.summary}</Text>
            {lastResult.errors.length > 0 && (
              <View style={{ marginTop: 6 }}>
                {lastResult.errors.map((e, i) => (
                  <Text key={i} style={styles.resultError}>
                    · {e.stage}: {e.message}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}

        {listScenarios().map(s => {
          const busy = busyId === s.id;
          return (
            <TouchableOpacity
              key={s.id}
              style={[styles.card, busy && { opacity: 0.5 }]}
              disabled={busyId !== null}
              onPress={() => confirmAndRun(
                'Wipe this account and seed?',
                `Scenario: ${s.label}\n\nThis deletes the current user's workout_sessions, exercise_logs, weekly_plans rows, and history-derived caches, then seeds the scenario via the real write helpers. Continue ONLY on a dev/test account.`,
                () => runSeed(s.id as ScenarioId, s.label),
              )}
              activeOpacity={0.8}
            >
              <Text style={styles.cardLabel}>{s.label}</Text>
              <Text style={styles.cardDesc}>{s.description}</Text>
              <Text style={styles.cardId}>{busy ? 'Seeding…' : s.id}</Text>
            </TouchableOpacity>
          );
        })}

        <View style={styles.divider} />

        <TouchableOpacity
          style={[styles.card, styles.dangerCard, busyId === 'wipe' && { opacity: 0.5 }]}
          disabled={busyId !== null}
          onPress={() => confirmAndRun(
            'Wipe account to fresh?',
            'Deletes ALL of this user\'s workout_sessions, exercise_logs, weekly_plans rows, and history-derived caches, AND clears the profile so the next launch goes back through onboarding. Dev/test accounts only.',
            runWipe,
          )}
          activeOpacity={0.8}
        >
          <Text style={[styles.cardLabel, { color: colors.accentCoral }]}>Wipe to fresh account</Text>
          <Text style={styles.cardDesc}>
            Clears every row + cache and resets onboarding_complete. The next
            launch routes through /welcome → onboarding.
          </Text>
          <Text style={styles.cardId}>{busyId === 'wipe' ? 'Wiping…' : 'wipe'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    padding: layout.spacing.lg,
    paddingBottom: layout.spacing.xxl,
  },
  notAvailable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: layout.spacing.xl,
  },
  notAvailableText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.md,
    color: colors.textMuted,
  },
  header: {
    marginBottom: layout.spacing.lg,
  },
  backChevron: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s14,
    color: colors.textSecondary,
    marginBottom: layout.spacing.sm,
  },
  title: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    color: colors.textPrimary,
    letterSpacing: 2,
    marginBottom: layout.spacing.sm,
  },
  warning: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    color: colors.accentCoral,
    lineHeight: 17,
  },
  resultCard: {
    padding: layout.spacing.md,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    backgroundColor: colors.surface,
    marginBottom: layout.spacing.md,
  },
  resultSummary: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s13,
    color: colors.textPrimary,
  },
  resultError: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s11,
    color: colors.textMuted,
  },
  card: {
    padding: layout.spacing.md,
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.surface,
    marginBottom: 8,
  },
  dangerCard: {
    borderColor: colors.accentCoral,
  },
  cardLabel: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.md,
    color: colors.textPrimary,
    marginBottom: 4,
  },
  cardDesc: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  cardId: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    color: colors.textMuted,
    letterSpacing: 1,
    marginTop: 6,
    textTransform: 'uppercase',
  },
  divider: {
    height: 1,
    backgroundColor: colors.cardBorder,
    marginVertical: layout.spacing.md,
  },
  // Platform-stub: keep RN happy about unused vars.
  _hidden: { display: Platform.OS === 'web' ? 'none' : 'flex' },
});
