// Surface — restrained material panel.
//
// Captures the v2 "tactile" treatment we want every signature card to share:
// matte layered fill, a 1px lit top edge (rgba white ~0.06) for a sense of
// being lit from above, and a soft drop shadow that grounds the panel against
// the canvas. No gloss, no bevels, no skeuomorphic frames.
//
// Intentionally minimal API — only `tone` (optional ambient glow color) and
// `children`. We do NOT refactor every existing card onto Surface in this
// pass; CoachVoiceHero is the first adopter and the stat cards can migrate
// incrementally.

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { layout, elevation } from '../theme';
import { useTheme } from '../context/ThemeContext';

interface SurfaceProps {
  children: React.ReactNode;
  /** Optional ambient glow color rendered behind the panel at very low alpha.
   *  Omit for a flat material. Used by CoachVoiceHero to re-light the panel
   *  by training state without coloring the panel fill itself. */
  tone?: string;
  style?: ViewStyle | ViewStyle[];
}

export default function Surface({ children, tone, style }: SurfaceProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      {/* Ambient glow — sits behind the panel, soft and very low-alpha so it
          re-lights the area without coloring the fill. */}
      {tone ? (
        <View
          pointerEvents="none"
          style={[
            styles.glow,
            { backgroundColor: tone, shadowColor: tone },
          ]}
        />
      ) : null}
      {/* User `style` forwards to the inner panel — that's where
          flexDirection / padding / alignItems are actually meaningful.
          Routing them to the outer wrap (a single-child container) would
          silently swallow row layouts and shrink the panel to its
          intrinsic content width, which is how the dashboard cards
          collapsed into narrow columns before. */}
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
    // Matches colors.cardBorder. Inlined because module-scope StyleSheet
    // can't see useTheme()'s colors closure.
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
});
