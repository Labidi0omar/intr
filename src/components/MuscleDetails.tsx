// MuscleDetails — expandable card showing the targeted muscle's body
// position (front or back muscle map with the worked region highlighted)
// and a short paragraph in the app's voice about what the muscle is and
// why it matters.
//
// Pure, presentational — no state, no network, no AsyncStorage. The
// parent owns the expand/collapse state and mounts/unmounts this card.
//
// The figure comes from react-native-body-highlighter — anatomically
// correct front and back paths, so "BACK VIEW" actually shows a back
// (and triceps highlight on the back of the arm, not the front).

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Body from 'react-native-body-highlighter';
import { layout, typography } from '../theme';
import { useTheme } from '../context/ThemeContext';
import { getMuscleInfo } from '../constants/muscleInfo';
import { reportSilent } from '../lib/errorReporting';

interface MuscleDetailsProps {
  /** The exercise's primaryMuscle field (e.g. "chest", "back", "rear delts"). */
  muscle: string;
}

export default function MuscleDetails({ muscle }: MuscleDetailsProps) {
  const { colors } = useTheme();
  const info = getMuscleInfo(muscle);
  if (!info) return null;

  // Render guard for the muscle figure. If the lib ever throws (bad slug
  // after a future upgrade, etc.) we still want the description text to
  // appear — the figure is a nice-to-have, not load-bearing.
  let figure: React.ReactNode = null;
  if (info.slug) {
    try {
      figure = (
        <Body
          side={info.view}
          scale={0.55}
          border="none"
          defaultFill={colors.surfaceElevated}
          data={[{ slug: info.slug, color: colors.accentTeal }]}
        />
      );
    } catch (e) {
      reportSilent(e, 'MuscleDetails:body');
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.diagramRow}>
        <View style={styles.figureCol}>{figure}</View>
        <View style={styles.labelCol}>
          <Text style={[styles.regionLabel, { color: colors.textMuted }]}>
            {info.view === 'front' ? 'FRONT' : 'BACK'} VIEW
          </Text>
          <Text style={[styles.regionValue, { color: colors.textSecondary }]}>
            {info.region}
          </Text>
        </View>
      </View>
      <Text style={[styles.name, { color: colors.textPrimary }]}>
        {info.name}
      </Text>
      <Text style={[styles.description, { color: colors.textSecondary }]}>
        {info.description}
      </Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    paddingVertical: layout.spacing.md,
    paddingHorizontal: layout.spacing.md,
    gap: layout.spacing.sm,
  },
  diagramRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: layout.spacing.md,
  },
  // The Body component renders at its intrinsic SVG size scaled by `scale`.
  // We pin the column to a fixed width and center the figure inside it so
  // front and back render at the same on-screen footprint, regardless of
  // their underlying viewBox widths.
  figureCol: {
    width: 130,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelCol: {
    flex: 1,
    justifyContent: 'center',
  },
  regionLabel: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s10,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  regionValue: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
  },
  name: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    marginTop: layout.spacing.xs,
  },
  description: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    lineHeight: 22,
  },
});
