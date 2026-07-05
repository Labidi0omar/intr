// Accent-model legend — makes the three-accent discipline visible.
//
// DESIGN_DIRECTION.md, "Accent model — one action accent + locked
// semantics (NOT single-accent)":
//   • teal is the ONLY action / active-state color
//   • coral / amber / positive / red / rest are LOCKED to encoded data
//     meaning — never used for decoration
//
// The legend on the primitives-gallery screen renders every accent + its
// rule so a reviewer can eyeball the discipline in one place before
// approving Phase 3.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { layout, typography } from '../../theme';

interface LegendEntry {
  colorKey:
    | 'accentTeal'
    | 'accentCoral'
    | 'accentAmber'
    | 'accentPositive'
    | 'accentRed'
    | 'accentRest';
  name: string;
  role: 'ACTION' | 'MEANING';
  rule: string;
}

const ENTRIES: LegendEntry[] = [
  {
    colorKey: 'accentTeal',
    name: 'Teal',
    role: 'ACTION',
    rule: 'Buttons, active tabs, logging state. Nothing else.',
  },
  {
    colorKey: 'accentCoral',
    name: 'Coral',
    role: 'MEANING',
    rule: 'Streak / energy / heat.',
  },
  {
    colorKey: 'accentAmber',
    name: 'Amber',
    role: 'MEANING',
    rule: 'PR / ratio / achievement / holding steady.',
  },
  {
    colorKey: 'accentPositive',
    name: 'Emerald',
    role: 'MEANING',
    rule: 'Easy effort / reps in the tank / completed.',
  },
  {
    colorKey: 'accentRed',
    name: 'Red',
    role: 'MEANING',
    rule: 'Max effort / destructive only.',
  },
  {
    colorKey: 'accentRest',
    name: 'Indigo',
    role: 'MEANING',
    rule: 'Rest / recovery (deliberately never red).',
  },
];

export default function AccentLegend() {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      {ENTRIES.map(entry => {
        const swatch = colors[entry.colorKey];
        const roleColor = entry.role === 'ACTION' ? colors.accentTeal : colors.textMuted;
        return (
          <View
            key={entry.colorKey}
            style={[styles.row, { borderBottomColor: colors.cardBorder }]}
          >
            <View style={[styles.swatch, { backgroundColor: swatch }]} />
            <View style={styles.textCol}>
              <View style={styles.nameRow}>
                <Text style={[styles.name, { color: colors.textPrimary }]}>{entry.name}</Text>
                <Text style={[styles.role, { color: roleColor }]}>{entry.role}</Text>
              </View>
              <Text style={[styles.rule, { color: colors.textSecondary }]}>{entry.rule}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: layout.spacing.md,
    paddingVertical: layout.spacing.sm,
    borderBottomWidth: 1,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: layout.smRadius,
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: layout.spacing.sm,
  },
  name: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    letterSpacing: -0.2,
  },
  role: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.xxs,
    letterSpacing: 2,
  },
  rule: {
    fontFamily: typography.family.body,
    fontSize: typography.size.xs,
    lineHeight: 17,
  },
});
