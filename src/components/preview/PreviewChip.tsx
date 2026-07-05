// Filter / status CHIP primitive — Phase 2 preview.
//
// Complements src/components/PillFilter.tsx (which is a horizontally
// scrolling *group*). This is a single chip used in row/grid layouts —
// selected/unselected filter buttons, status labels, secondary options.
//
// The active state uses accentTeal (border + label) — the ONE action
// accent, matching the DESIGN_DIRECTION discipline. A `tone` prop is
// available for status-chip usage where the chip encodes data meaning
// (e.g. "Deload" amber, "Rest" indigo) — reach for it only in those
// semantic cases, never for a filter pill.

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, type ViewStyle } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { layout, typography } from '../../theme';

interface PreviewChipProps {
  label: string;
  active?: boolean;
  onPress?: () => void;
  /** Semantic accent (coral / amber / positive / red / rest). When set,
   *  border + label render in this color regardless of active state. Use
   *  ONLY for encoded meaning; never for filter selection state. */
  tone?: string;
  disabled?: boolean;
  style?: ViewStyle;
}

export default function PreviewChip({
  label,
  active = false,
  onPress,
  tone,
  disabled = false,
  style,
}: PreviewChipProps) {
  const { colors } = useTheme();
  const activeColor = colors.accentTeal;
  const borderColor = tone ?? (active ? activeColor : colors.border);
  const textColor = tone ?? (active ? activeColor : colors.textSecondary);
  return (
    <TouchableOpacity
      style={[
        styles.chip,
        {
          borderColor,
          backgroundColor: active && !tone ? colors.surface : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
    >
      <Text
        style={[
          styles.label,
          {
            color: textColor,
            fontFamily: active
              ? typography.family.bodyMedium
              : typography.family.body,
          },
        ]}
        numberOfLines={1}
      >
        {label.toUpperCase()}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderRadius: layout.pillRadius,
    paddingHorizontal: 14,
    paddingVertical: 7,
    minHeight: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: {
    fontSize: typography.size.xxs,
    letterSpacing: 1.2,
  },
});
