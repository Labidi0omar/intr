// Proposed shared SHEET / MODAL primitive — Phase 2 preview.
//
// Every modal in production today is built inline (delete-account,
// swap-exercise, weight-input, gap ack, share preview, energy prompt).
// Each has its own overlay opacity, its own handle glyph, its own corner
// treatment. This is the one pattern the gallery reviews.
//
// Anatomy:
//   ── full-screen scrim (colors.scrimMedium) ──
//   ── bottom-anchored sheet ──
//        • handle grab-bar (small pill, textMuted)
//        • header title (Syne 700 lg)
//        • body content (children)
//        • close via the scrim tap or an explicit action button
//   ────────────────────────────────────────────
//
// This is a *presentational* wrapper — the caller controls `visible`,
// wraps in Modal itself, or renders this inline inside their own Modal.
// The preview gallery does the latter to keep the demo self-contained.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { layout, typography } from '../../theme';

interface PreviewSheetProps {
  title: string;
  onDismiss: () => void;
  children: React.ReactNode;
}

export default function PreviewSheet({ title, onDismiss, children }: PreviewSheetProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.scrim, { backgroundColor: colors.scrimMedium }]}>
      <Pressable style={StyleSheet.absoluteFill as any} onPress={onDismiss} accessibilityLabel="Close sheet" />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.surface,
            borderColor: colors.cardBorder,
          },
        ]}
      >
        {/* 1px lit top edge — signature move, same as PreviewSurface. */}
        <View pointerEvents="none" style={styles.litEdge} />
        <View style={[styles.handle, { backgroundColor: colors.textMuted }]} />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: layout.cardRadius,
    borderTopRightRadius: layout.cardRadius,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: layout.spacing.lg,
    paddingBottom: layout.spacing.xxl,
    paddingTop: layout.spacing.md,
    overflow: 'hidden',
  },
  litEdge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: layout.smRadius,
    alignSelf: 'center',
    marginBottom: layout.spacing.lg,
  },
  title: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    letterSpacing: -0.2,
    marginBottom: layout.spacing.lg,
  },
});
