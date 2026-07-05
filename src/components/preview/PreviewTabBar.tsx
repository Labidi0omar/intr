// Proposed shared TAB BAR primitive — Phase 2 preview.
//
// Production ships one big TabLayout coupled to router state; the gallery
// needs a decoupled, presentational tab bar to show the treatment on its
// own. Same visual pattern (segmented pill row) — no router side effects,
// caller manages selection.
//
// Discipline: the active tab uses accentTeal (the ONE action accent).
// Inactive tabs use textMuted. No semantic colors here — a tab is
// interaction state, not encoded meaning.

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { layout, typography } from '../../theme';

interface PreviewTabBarProps {
  tabs: string[];
  active: number;
  onSelect: (index: number) => void;
}

export default function PreviewTabBar({ tabs, active, onSelect }: PreviewTabBarProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.wrap, { backgroundColor: colors.surface }]}>
      {tabs.map((label, i) => {
        const isActive = i === active;
        return (
          <TouchableOpacity
            key={label}
            style={[
              styles.item,
              isActive && { backgroundColor: colors.surfaceElevated },
            ]}
            onPress={() => onSelect(i)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.label,
                { color: isActive ? colors.accentTeal : colors.textMuted },
              ]}
            >
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderRadius: layout.cardRadius,
    padding: 6,
    gap: 4,
  },
  item: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: layout.smRadius,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  label: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.xs,
    letterSpacing: 0.4,
  },
});
