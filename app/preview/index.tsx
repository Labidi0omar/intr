// Phase-2 preview hub. Dev-only landing that links to the primitives
// gallery + the rebuilt workout screen so a reviewer can navigate the
// approved design system on a real device before Phase 3 begins.
//
// Guarded two ways:
//   1. __DEV__ — release builds never render the entry cards; instead
//      they show a plain "not available" notice, matching the
//      dev-scenarios.tsx pattern. A production APK deep-linking to
//      /preview lands on the notice, never on the gallery.
//   2. PREVIEW_ENABLED — a dev-time kill switch in src/constants/
//      previewFlags.ts. Flip to false to confirm the guard renders.
//
// Reach it during dev by opening the URL /preview:
//   • Web dev:   http://localhost:8081/preview
//   • Native dev: the Expo dev menu → "Open URL" → enter /preview
//                 (or trigger router.push('/preview') from any dev-only
//                 hook you add temporarily to your own local branch)
//
// Registered by Expo Router file-based discovery — no edit to
// app/_layout.tsx required. The whole preview namespace deletes cleanly
// when Phase 3 lands.

import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../src/context/ThemeContext';
import { layout, typography } from '../../src/theme';
import { PREVIEW_ENABLED } from '../../src/constants/previewFlags';
import PreviewHeader from '../../src/components/preview/PreviewHeader';
import PreviewSurface from '../../src/components/preview/PreviewSurface';

export default function PreviewHubScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const styles = makeStyles(colors);

  if (!__DEV__ || !PREVIEW_ENABLED) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.notAvailable}>
          <Text style={styles.notAvailableText}>Not available in this build.</Text>
        </View>
      </SafeAreaView>
    );
  }

  // href is cast at push-time because Expo Router's typed-routes
  // generator hasn't seen /preview/* until the dev server rebuilds
  // route types. The cast keeps the preview namespace self-contained
  // without asking the reviewer to run a build first.
  const entries: { title: string; subtitle: string; href: string }[] = [
    {
      title: 'Primitives Gallery',
      subtitle: 'Every component, every state, the accent legend.',
      href: '/preview/gallery',
    },
    {
      title: 'Workout — Rebuilt',
      subtitle: 'The core loop, mocked. Traffic-light effort scale in place.',
      href: '/preview/workout',
    },
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <PreviewHeader
        eyebrow="PHASE 2 PREVIEW"
        title="Design System"
        onBack={() => router.back()}
        divider
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          Dev-only. Review the treatment on device, then approve or send notes.
          Production screens are untouched.
        </Text>
        {entries.map(entry => (
          <TouchableOpacity
            key={entry.href}
            activeOpacity={0.8}
            onPress={() => router.push(entry.href as never)}
          >
            <PreviewSurface>
              <Text style={styles.cardTitle}>{entry.title}</Text>
              <Text style={styles.cardSubtitle}>{entry.subtitle}</Text>
            </PreviewSurface>
          </TouchableOpacity>
        ))}
        <Text style={styles.footer}>
          Delete `app/preview/` + `src/components/preview/` + `src/constants/previewFlags.ts` when Phase 3 lands.
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
      textAlign: 'center',
    },
    content: {
      padding: layout.spacing.lg,
      gap: layout.spacing.sm,
    },
    intro: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      lineHeight: 21,
      marginBottom: layout.spacing.md,
    },
    cardTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      color: colors.textPrimary,
      letterSpacing: -0.2,
    },
    cardSubtitle: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      lineHeight: 20,
      marginTop: 4,
    },
    footer: {
      fontFamily: typography.family.body,
      fontSize: typography.size.xxs,
      color: colors.textMuted,
      textAlign: 'center',
      marginTop: layout.spacing.xl,
      letterSpacing: 0.4,
    },
  });
