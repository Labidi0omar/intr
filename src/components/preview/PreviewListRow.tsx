// Proposed shared LIST ROW primitive — Phase 2 preview.
//
// The audit flagged rows as re-invented on every screen (profile settings,
// history, month calendar day details, forward-30 lists). This is the one
// pattern the gallery reviews.
//
// Anatomy:
//   [ optional dot ] title              value / chevron
//                  optional subtitle
//
// - `tone` renders a small colored dot on the left. Only ever used for
//   data-meaning (semantic accent set), never decoration. Omit for a
//   plain row.
// - `value` sits on the right — a numeric readout, status label, or a
//   caret glyph. Pass "" for none.
// - `onPress` makes the whole row a touch target with a subtle pressed
//   state; omit for a display-only row.
// - `divider` draws a 1px bottom hairline (used when stacking rows in a
//   Surface panel).

import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { layout, typography } from '../../theme';

interface PreviewListRowProps {
  title: string;
  subtitle?: string;
  value?: string;
  /** Semantic accent dot color. Only reach for the semantic set (coral /
   *  amber / positive / red / rest). Never teal — teal is action-only. */
  tone?: string;
  onPress?: () => void;
  divider?: boolean;
  style?: ViewStyle;
}

export default function PreviewListRow({
  title,
  subtitle,
  value,
  tone,
  onPress,
  divider = false,
  style,
}: PreviewListRowProps) {
  const { colors } = useTheme();
  const inner = (
    <View
      style={[
        styles.row,
        divider && { borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
        style,
      ]}
    >
      {tone ? <View style={[styles.dot, { backgroundColor: tone }]} /> : null}
      <View style={styles.textCol}>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.textMuted }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
    </View>
  );

  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [pressed && { backgroundColor: colors.surfaceElevated }]}
      accessibilityRole="button"
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.spacing.md,
    paddingVertical: layout.spacing.md,
    gap: layout.spacing.sm,
    minHeight: 52,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: layout.radii.r4,
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.sm,
  },
  subtitle: {
    fontFamily: typography.family.body,
    fontSize: typography.size.xs,
    lineHeight: 17,
  },
  value: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    fontVariant: ['tabular-nums'],
  },
});
