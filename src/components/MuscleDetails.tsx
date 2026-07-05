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
// (and triceps highlight on the back of the arm, not the front). When
// the exercise carries an `emphasis` (see src/lib/muscleEmphasis.ts),
// we hand off to MuscleOverlay which either delegates to the library's
// native slug or overlays a custom sub-region path on top of the base
// figure. When emphasis is unset, the render path is byte-for-byte the
// pre-emphasis behavior (same <Body> shape, same slug lookup).

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { layout, typography } from '../theme';
import { useTheme } from '../context/ThemeContext';
import { getMuscleInfo } from '../constants/muscleInfo';
import MuscleOverlay, { type MuscleHighlight } from './MuscleOverlay';
import { emphasisToRender, type MuscleEmphasis } from '../lib/muscleEmphasis';

interface MuscleDetailsProps {
  /** The exercise's primaryMuscle field (e.g. "chest", "back", "rear delts"). */
  muscle: string;
  /** Optional sub-region emphasis from the exercise catalog. When set,
   *  the figure highlights just this sub-region instead of the full
   *  muscle slug. When unset, behavior is byte-for-byte the pre-emphasis
   *  render — the native slug from muscleInfo. */
  emphasis?: MuscleEmphasis;
}

export default function MuscleDetails({ muscle, emphasis }: MuscleDetailsProps) {
  const { colors } = useTheme();
  const info = getMuscleInfo(muscle);
  if (!info) return null;

  // Resolve the (view, highlight) pair. When the exercise has an
  // emphasis it wins — for a rear-delt fly the view flips to 'back'
  // even though the muscleInfo entry for 'shoulders' says 'front'. When
  // there's no emphasis, we fall back to the pre-emphasis behavior:
  // the view + slug from muscleInfo, exactly as before.
  const rendered = emphasis ? emphasisToRender(emphasis) : null;
  const view: 'front' | 'back' = rendered ? rendered.view : info.view;
  const highlight: MuscleHighlight = rendered
    ? rendered.kind === 'native'
      ? { kind: 'native', slug: rendered.slug }
      : { kind: 'overlay', pathId: rendered.pathId }
    : info.slug
      ? { kind: 'native', slug: info.slug }
      : null;

  const figure: React.ReactNode = (
    <MuscleOverlay
      view={view}
      highlight={highlight}
      color={colors.accentTeal}
      scale={0.55}
      defaultFill={colors.surfaceElevated}
    />
  );

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
