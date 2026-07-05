// Proposed shared HEADER primitive — Phase 2 preview.
//
// Every production screen builds its own header inline today; the audit
// (PHASE0_AUDIT.md, I-6 area) flagged this as a top inconsistency source.
// This is the one consistent pattern the gallery reviews:
//
//   • Optional back chevron on the left (tap target ≥ 44px)
//   • Title in Syne 700, semantic `lg` (22px), primary text color
//   • Optional right-slot for a single icon action (swap, share, etc.)
//   • Optional eyebrow kicker above the title, DM Sans 500 xxs uppercase
//     with wide letter-spacing — the recurring "COACH'S CALL" / "WEEK 3"
//     style label
//   • 1px hairline under the header when `divider` is set
//
// No fancy fades, no scroll-linked collapse — restrained by design.
// Interaction: back arrow uses the standard press feedback (opacity 0.7).

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { layout, typography } from '../../theme';

interface PreviewHeaderProps {
  /** The big title line. Rendered in Syne 700 lg. */
  title: string;
  /** Optional small uppercase kicker rendered above the title. */
  eyebrow?: string;
  /** Show a back chevron on the left; wire your own onBack. */
  onBack?: () => void;
  /** Optional trailing text/glyph action (e.g. swap "⇄"). */
  rightGlyph?: string;
  onRightPress?: () => void;
  /** Draw the 1px bottom hairline. Off by default for large-title
   *  landings; on for dense content screens (workout / gallery). */
  divider?: boolean;
  style?: ViewStyle;
}

export default function PreviewHeader({
  title,
  eyebrow,
  onBack,
  rightGlyph,
  onRightPress,
  divider = false,
  style,
}: PreviewHeaderProps) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.wrap,
        divider && { borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
        style,
      ]}
    >
      <View style={styles.row}>
        {onBack ? (
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onBack}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={[styles.chevron, { color: colors.textSecondary }]}></Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.iconBtn} />
        )}
        <View style={styles.center}>
          {eyebrow ? (
            <Text style={[styles.eyebrow, { color: colors.accentTeal }]} numberOfLines={1}>
              {eyebrow.toUpperCase()}
            </Text>
          ) : null}
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {rightGlyph ? (
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onRightPress}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
          >
            <Text style={[styles.rightGlyph, { color: colors.textSecondary }]}>{rightGlyph}</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.iconBtn} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: layout.spacing.md,
    paddingVertical: layout.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    lineHeight: 22,
  },
  rightGlyph: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    lineHeight: 22,
  },
  center: {
    flex: 1,
    alignItems: 'center',
  },
  eyebrow: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.xxs,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  title: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    letterSpacing: -0.2,
  },
});
