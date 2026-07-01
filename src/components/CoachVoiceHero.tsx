// CoachVoiceHero — the v2 dashboard signature.
//
// No avatar. The "coach" is a confident spoken line in large editorial type,
// set on the shared tactile Surface and re-lit by the user's training state
// via coachTintFor. Pre-workout only (the host screen owns the gate; this
// component just renders what it's given).
//
// The line itself comes from the existing observation pipeline — host passes
// the deterministic phraseObservation output, and the AI rephrase swap-in
// happens upstream via runCoachVoiceUpgrade (deterministic-first, AI-best-
// effort, fails open). We deliberately don't read coachMessages here so the
// hero stays a pure render — no AsyncStorage, no Supabase.
//
// Renders nothing when there's no line, so a parent that wraps it in a
// pre-workout gate doesn't need a second null check.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { reportSilent } from '../lib/errorReporting';
import { coachTintFor } from '../lib/coachTint';
import type { TrainingStatusState } from '../lib/trainingStatus';
import { layout, typography } from '../theme';
import { useTheme } from '../context/ThemeContext';
import Surface from './Surface';

interface CoachVoiceHeroProps {
  /** The coach's hero line — already phrased by the existing pipeline
   *  (phraseObservation → runCoachVoiceUpgrade rephrase). */
  line: string | null | undefined;
  /** Current training state (recovering_well / holding_steady / backing_off /
   *  unknown). Null collapses to 'unknown' tint. */
  trainingState: TrainingStatusState | null | undefined;
  /** When true the kicker reads "COACH JUST NOTICED" to mark a fresh,
   *  unseen observation — same convention as the existing coach card. */
  unseen?: boolean;
}

export default function CoachVoiceHero({
  line,
  trainingState,
  unseen = false,
}: CoachVoiceHeroProps) {
  const { colors } = useTheme();

  // Render nothing rather than throwing — the hero is best-effort.
  try {
    const text = typeof line === 'string' ? line.trim() : '';
    if (!text) return null;

    const state: TrainingStatusState = trainingState ?? 'unknown';
    const { tint, glow } = coachTintFor(state);

    return (
      <Surface tone={glow}>
        <Text
          style={[
            styles.kicker,
            { color: tint, opacity: state === 'unknown' ? 0.7 : 1 },
          ]}
          accessibilityRole="text"
        >
          {unseen ? 'COACH JUST NOTICED' : 'COACH'}
        </Text>
        <Text
          style={[styles.headline, { color: tint }]}
          // Hard layout contract: a long line shrinks gracefully (down to
          // 65% of the editorial size) and clamps at 4 lines. With the
          // upstream 130-char cap on the line itself, this keeps the hero
          // from EVER exploding into the "wall of 8+ lines" we saw in the
          // pre-rewrite screenshots.
          numberOfLines={4}
          adjustsFontSizeToFit
          minimumFontScale={0.65}
          accessibilityLabel={`Coach: ${text}`}
        >
          {text}
        </Text>
        {/* Soft grain — a single low-alpha overlay tile. Adds the tactile
            "matte" beat without a texture asset. Kept very subtle so the
            type remains crisp; deliberately not interactive. */}
        <View pointerEvents="none" style={[styles.grain, { backgroundColor: colors.textPrimary }]} />
      </Surface>
    );
  } catch (e) {
    reportSilent(e, 'CoachVoiceHero:render');
    return null;
  }
}

const styles = StyleSheet.create({
  kicker: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s10,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: layout.spacing.sm,
  },
  headline: {
    // Editorial scale — large Syne Bold, tight tracking. The "spoken line"
    // weight comes from the size + the per-state tint, not from a frame.
    fontFamily: typography.family.heading,
    fontSize: typography.size.s30,
    lineHeight: 36,
    letterSpacing: -0.6,
  },
  grain: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.015,
  },
});
