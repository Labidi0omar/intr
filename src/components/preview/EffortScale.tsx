// EFFORT SCALE — the signature traffic-light selector.
//
// DESIGN_DIRECTION.md signature move #1: "The RIR selector (Easy=emerald
// / Hard=amber / Max=red) reads as instant color-coded meaning with no
// reading required. This is the one place multiple accents appear
// together, and it's load-bearing, not decorative."
//
// Palette map (per DESIGN_DIRECTION):
//   Easy   → emerald (positive) — "you had reps left"
//   Solid  → textPrimary — the target zone; NEUTRAL by design so the
//                          traffic-light (red / amber / emerald) is the
//                          visible signature and teal is preserved for
//                          action-only elsewhere. Production currently
//                          uses teal for Solid; that violates the
//                          accent discipline and is exactly the drift
//                          Phase 2 is proposing to correct.
//   Hard   → amber — "you were close to failure"
//   Max    → red — "you failed"
//
// Behaviour is intentionally minimal — no async commit, no navigation —
// so the gallery / preview workout can show the treatment. The caller
// owns state via `selected` + `onSelect`.

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { layout, typography } from '../../theme';

export type EffortLevel = 'easy' | 'solid' | 'hard' | 'max';

interface EffortScaleProps {
  selected?: EffortLevel | null;
  onSelect: (level: EffortLevel) => void;
}

export default function EffortScale({ selected = null, onSelect }: EffortScaleProps) {
  const { colors } = useTheme();

  // The palette lives inside the component so the map picks up the
  // frozen theme colors without threading them through every option
  // literal. Order is Easy → Max, left-to-right — matches how the RIR
  // scale reads on the workout screen.
  const options: {
    level: EffortLevel;
    label: string;
    sub: string;
    color: string;
  }[] = [
    { level: 'easy',  label: 'Easy',  sub: '4+ left',   color: colors.accentPositive },
    { level: 'solid', label: 'Solid', sub: '2–3 left',  color: colors.textPrimary },
    { level: 'hard',  label: 'Hard',  sub: '1 left',    color: colors.accentAmber },
    { level: 'max',   label: 'Max',   sub: 'Failed',    color: colors.accentRed },
  ];

  return (
    <View style={styles.row}>
      {options.map(opt => {
        const isSelected = selected === opt.level;
        return (
          <TouchableOpacity
            key={opt.level}
            style={[
              styles.chip,
              {
                borderColor: opt.color,
                backgroundColor: isSelected ? opt.color + '18' : 'transparent',
              },
            ]}
            onPress={() => onSelect(opt.level)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={`${opt.label} — ${opt.sub}`}
            accessibilityState={{ selected: isSelected }}
          >
            <Text
              style={[styles.label, { color: opt.color }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.78}
              allowFontScaling={false}
            >
              {opt.label}
            </Text>
            <Text
              style={[styles.sub, { color: colors.textMuted }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              allowFontScaling={false}
            >
              {opt.sub}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: layout.spacing.sm,
  },
  chip: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: layout.cardRadius,
    paddingVertical: 14,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 70,
    gap: 2,
  },
  label: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.sm,
    letterSpacing: 0.4,
  },
  sub: {
    fontFamily: typography.family.body,
    fontSize: typography.size.xxs,
    letterSpacing: 0.4,
  },
});
