// Workout execution screen — Phase-2 rebuild in the preview namespace.
//
// The core loop, highest-traffic, hardest surface. Rebuilt with the
// approved primitives so a reviewer can prove the system holds on the
// screen most likely to break it. Deliberately mocked / stubbed:
//   • No Supabase reads or writes.
//   • No navigation side effects beyond `router.back()` on the header.
//   • No prescription engine wired in — the "COACH'S CALL" text is
//     hard-coded from a plausible fixture so the layout can be reviewed.
//   • No pending-save queue, no analytics, no notification schedule.
//
// The point is to prove the design system holds on the hardest screen —
// NOT to replicate business logic. When Phase 3 lands, the production
// app/workout.tsx will be restyled to use the same primitives (or
// promoted equivalents) and this preview copy gets deleted.
//
// Visual anchors preserved from the production screen:
//   1. Session header with progress ("2 / 4")
//   2. Exercise image slot (placeholder here — no network fetches)
//   3. Title + swap icon row
//   4. Sets × reps
//   5. Last-used reference ("Last: 80 kg · 3 days ago")
//   6. COACH'S CALL hero (kg + delta + reason)
//   7. Effort scale (Easy / Solid / Hard / Max) — the SIGNATURE traffic-light
//   8. Next-exercise CTA
//
// The traffic-light color semantics (Easy=emerald / Solid=neutral /
// Hard=amber / Max=red) are the exact discipline the three-accent
// decision protects. Selecting a chip here is a no-op with a local
// visual echo; production commits the log + advances.

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Button from '../../src/components/Button';
import { useTheme } from '../../src/context/ThemeContext';
import { layout, typography } from '../../src/theme';
import { PREVIEW_ENABLED } from '../../src/constants/previewFlags';
import EffortScale, { type EffortLevel } from '../../src/components/preview/EffortScale';
import PreviewHeader from '../../src/components/preview/PreviewHeader';
import PreviewSurface from '../../src/components/preview/PreviewSurface';

// ── Mock fixtures ────────────────────────────────────────────────────
// A single plausible exercise + coach output. No hooks, no fetches; a
// stable shape the layout can render deterministically.

const MOCK_EXERCISE = {
  name: 'Back Squat',
  sets: 4,
  reps: '5–8',
  primaryMuscle: 'LEGS',
  lastKg: 80,
  lastAgo: '3 days ago',
  progressLabel: '2 / 4',
} as const;

const MOCK_COACH = {
  eyebrow: "COACH'S CALL",
  weightLabel: '85 kg',
  deltaLabel: '+5 kg vs last',
  reason: "You've held 80 kg for 3 weeks — time to add a little. Earn it.",
} as const;

export default function WorkoutPreviewScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const styles = makeStyles(colors);

  // Local-only interaction state. Selecting an effort chip echoes the
  // choice inline; there's no commit path (this is a preview).
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [advanced, setAdvanced] = useState(false);

  if (!__DEV__ || !PREVIEW_ENABLED) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.notAvailable}>
          <Text style={styles.notAvailableText}>Not available in this build.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <PreviewHeader
        eyebrow={`SET ${MOCK_EXERCISE.progressLabel}`}
        title={MOCK_EXERCISE.name}
        onBack={() => router.back()}
        rightGlyph="⇄"
        onRightPress={() => {}}
        divider
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Exercise image placeholder ─────────────────────────
            Production fetches from the catalog + supports a 2-frame
            demo loop. Preview shows a neutral surface — the point is
            the treatment (rounded, letterboxed), not the media. */}
        <View style={styles.imageWrap}>
          <Image
            source={{ uri: 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=800' }}
            style={styles.image}
            resizeMode="cover"
          />
          <View style={styles.imageBadge}>
            <Text style={styles.imageBadgeText}>PREVIEW</Text>
          </View>
        </View>

        {/* ── Sets × reps + last-used reference ─────────────────── */}
        <View style={styles.metaRow}>
          <Text style={styles.setsReps}>
            {MOCK_EXERCISE.sets} × {MOCK_EXERCISE.reps}
          </Text>
          <Text style={styles.muscle}>{MOCK_EXERCISE.primaryMuscle}</Text>
        </View>
        <Text style={styles.lastUsed}>
          Last:{' '}
          <Text style={styles.lastUsedValue}>{MOCK_EXERCISE.lastKg} kg</Text>
          {' · '}{MOCK_EXERCISE.lastAgo}
        </Text>

        {/* ── COACH'S CALL — the prescription hero ──────────────── */}
        <PreviewSurface style={styles.heroSurface}>
          <Text style={styles.heroEyebrow}>{MOCK_COACH.eyebrow}</Text>
          <View style={styles.heroRow}>
            <Text style={styles.heroWeight}>{MOCK_COACH.weightLabel}</Text>
            <Text style={styles.heroDelta}>{MOCK_COACH.deltaLabel}</Text>
          </View>
          <Text style={styles.heroReason}>{MOCK_COACH.reason}</Text>
        </PreviewSurface>

        {/* ── Effort scale — SIGNATURE MOVE ─────────────────────── */}
        <Text style={styles.effortHeader}>How hard was that set?</Text>
        <Text style={styles.effortHelper}>
          Traffic-light color coding — the coach reads this to set next session's weight.
        </Text>
        <EffortScale
          selected={effort}
          onSelect={(level) => {
            setEffort(level);
            setAdvanced(true);
          }}
        />
        {advanced ? (
          <Text style={[styles.effortEcho, { color: colors.accentTeal }]}>
            Logged as {effort?.toUpperCase()} — preview only, nothing saved.
          </Text>
        ) : (
          <Text style={styles.effortEcho}>Tap a chip to log the set.</Text>
        )}

        <View style={styles.secondaryRow}>
          <TouchableOpacity onPress={() => {}} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.secondaryLink}>Log without rating</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {}} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.secondaryLink}>Skip this set</Text>
          </TouchableOpacity>
        </View>

        {/* ── Next-exercise CTA ─────────────────────────────────── */}
        <View style={styles.ctaWrap}>
          <Button title="Next exercise" onPress={() => {}} variant="primary" />
        </View>

        <Text style={styles.footer}>
          Preview surface — no data written, no navigation triggered.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    notAvailable: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: layout.spacing.lg,
    },
    notAvailableText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.md,
      color: colors.textMuted,
    },
    content: {
      padding: layout.spacing.lg,
      paddingBottom: layout.spacing.xxl,
    },
    imageWrap: {
      position: 'relative',
      borderRadius: layout.cardRadius,
      overflow: 'hidden',
      backgroundColor: colors.surfaceElevated,
      marginBottom: layout.spacing.md,
    },
    image: {
      width: '100%',
      aspectRatio: 16 / 9,
    },
    imageBadge: {
      position: 'absolute',
      top: layout.spacing.sm,
      left: layout.spacing.sm,
      backgroundColor: colors.background + 'CC',
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: layout.smRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
    },
    imageBadgeText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.xxs,
      color: colors.textSecondary,
      letterSpacing: 1.6,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    setsReps: {
      fontFamily: typography.family.body,
      fontSize: typography.size.md,
      color: colors.textSecondary,
    },
    muscle: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.xxs,
      color: colors.textMuted,
      letterSpacing: 2,
    },
    lastUsed: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      color: colors.textMuted,
      marginBottom: layout.spacing.md,
    },
    lastUsedValue: {
      color: colors.textSecondary,
    },
    heroSurface: {
      // Left-border accent teal to echo the "action" role — this is the
      // one place on the screen where teal reads as "the coach is
      // actively proposing something to do."
      borderLeftWidth: 3,
      borderLeftColor: colors.accentTeal,
      marginTop: layout.spacing.sm,
    },
    heroEyebrow: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.xxs,
      letterSpacing: 2,
      color: colors.accentTeal,
      marginBottom: 6,
    },
    heroRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: layout.spacing.sm,
      marginBottom: 4,
    },
    heroWeight: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xl,
      color: colors.textPrimary,
      letterSpacing: -0.6,
    },
    heroDelta: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
      color: colors.accentTeal,
    },
    heroReason: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      lineHeight: 21,
    },
    effortHeader: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.md,
      color: colors.textPrimary,
      marginTop: layout.spacing.lg,
      marginBottom: 4,
      letterSpacing: -0.2,
    },
    effortHelper: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      color: colors.textMuted,
      marginBottom: layout.spacing.md,
      lineHeight: 17,
    },
    effortEcho: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      color: colors.textMuted,
      marginTop: layout.spacing.md,
      textAlign: 'center',
    },
    secondaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: layout.spacing.md,
      paddingHorizontal: layout.spacing.xs,
    },
    secondaryLink: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      color: colors.textMuted,
      textDecorationLine: 'underline',
    },
    ctaWrap: {
      marginTop: layout.spacing.xl,
    },
    footer: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xxs,
      color: colors.textMuted,
      textAlign: 'center',
      marginTop: layout.spacing.lg,
      letterSpacing: 0.4,
    },
  });
