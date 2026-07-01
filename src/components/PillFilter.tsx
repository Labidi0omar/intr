import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { layout, typography } from '../theme';

interface PillFilterProps {
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
}

// Horizontal pill filter. Scrolls when content overflows; `directionalLockEnabled`
// keeps gestures pinned to one axis so the parent paged ScrollView (workout
// sub-tabs) doesn't hijack horizontal drags.
export default function PillFilter({ options, selected, onSelect }: PillFilterProps) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      directionalLockEnabled
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
    >
      {options.map(opt => {
        const isActive = opt === selected;
        return (
          <TouchableOpacity
            key={opt}
            style={[styles.pill, isActive && styles.pillActive]}
            onPress={() => onSelect(opt)}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          >
            <Text style={[styles.pillText, isActive && styles.pillTextActive]} numberOfLines={1}>
              {opt}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    row: {
      gap: 8,
      paddingHorizontal: layout.spacing.lg,
      paddingVertical: layout.spacing.xs,
      alignItems: 'center',
    },
    pill: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: layout.pillRadius,
      paddingHorizontal: 16,
      paddingVertical: 8,
      minHeight: 34,
      justifyContent: 'center',
    },
    pillActive: {
      borderColor: colors.accentTeal,
      backgroundColor: colors.surface,
    },
    pillText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      letterSpacing: 1.2,
      color: colors.textSecondary,
      textTransform: 'uppercase',
    },
    pillTextActive: {
      color: colors.accentTeal,
      fontFamily: typography.family.bodyMedium,
    },
  });
