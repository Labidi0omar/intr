// Signature card primitive for the Phase-2 preview.
//
// Restates the two locked "signature moves" from DESIGN_DIRECTION.md in a
// single tiny component so the gallery can review the treatment in one
// place before it lands on every production surface:
//
//   • Matte fill (colors.surface) with a 1px lit top edge
//     (rgba(255,255,255,0.06)) — "lit from above."
//   • Single soft drop shadow via elevation.panel — no blur, no heavy
//     nested shadows (Android perf).
//
// Behaviour is deliberately identical to src/components/Surface.tsx (the
// production component). This preview copy exists so the gallery + the
// preview workout screen can be reviewed in complete isolation without
// forcing a decision on the production Surface until Phase 3.

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { layout, elevation } from '../../theme';
import { useTheme } from '../../context/ThemeContext';

interface PreviewSurfaceProps {
  children: React.ReactNode;
  /** Optional ambient glow color rendered behind the panel at very low
   *  alpha. Omit for a flat matte panel — the default for every ordinary
   *  card. Only reach for `tone` when the panel is trying to express a
   *  training state (recovery / at-risk / celebrating), the same rule
   *  CoachVoiceHero follows in production. */
  tone?: string;
  style?: ViewStyle | ViewStyle[];
}

export default function PreviewSurface({ children, tone, style }: PreviewSurfaceProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      {tone ? (
        <View
          pointerEvents="none"
          style={[styles.glow, { backgroundColor: tone, shadowColor: tone }]}
        />
      ) : null}
      <View
        style={[
          styles.panel,
          {
            backgroundColor: colors.surface,
            borderColor: colors.cardBorder,
            shadowColor: colors.shadowColor,
          },
          style,
        ]}
      >
        <View pointerEvents="none" style={styles.litEdge} />
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    marginBottom: layout.spacing.md,
  },
  glow: {
    position: 'absolute',
    top: -8,
    left: -8,
    right: -8,
    bottom: -8,
    borderRadius: layout.cardRadius + 8,
    opacity: 0.08,
    ...elevation.glow,
  },
  panel: {
    borderRadius: layout.cardRadius,
    borderWidth: 1,
    padding: layout.spacing.lg,
    overflow: 'hidden',
    ...elevation.panel,
  },
  litEdge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    // Matches colors.cardBorder value. Inlined because module-scope
    // StyleSheet can't see useTheme()'s closure.
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
});
