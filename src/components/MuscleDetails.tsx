// MuscleDetails — animated "Muscles worked" card. Lights up the
// exercise's worked muscles on the body diagram in staggered order:
// primary mover first and brightest, supporting muscles after and
// dimmer. Labels ease in alongside. A single soft scale settle lands
// on the primary as it appears — no pulse loop.
//
// Data flow:
//   • deriveWorkedMuscles(primaryMuscle) → the ordered muscle list
//     (primary + supporting, derived via the muscleGroups normalizer;
//     no hand-authored synergist data).
//   • For each worked muscle, muscleInfo → the (view, slug) pair the
//     library needs. Supporting muscles whose default view doesn't
//     match the primary's view render as LABEL-ONLY (graceful
//     degradation — the panel still opens, no crash, we just don't
//     paint a highlight on the wrong side of the figure).
//   • For the primary, emphasis (if set) overrides the default slug —
//     either a native slug on a specific view, or a custom overlay
//     path via MuscleOverlay's existing conventions.
//
// Rendering: one base <Body> (never fades — provides the outline +
// defaultFill) with N stacked Reanimated body layers, one per
// highlighted muscle. Each layer's opacity + (primary only) scale
// tween starts on a staggered setTimeout. Reduce-motion skips the
// tweens entirely — every layer snaps to its resting values so the
// panel still shows the full picture.

import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import Body, { type Slug } from 'react-native-body-highlighter';
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { getMuscleInfo, type MuscleInfo } from '../constants/muscleInfo';
import { PATHS_BY_ID, type MusclePathId } from '../constants/musclePaths';
import { emphasisToRender, type MuscleEmphasis } from '../lib/muscleEmphasis';
import { deriveWorkedMuscles, type MuscleRole } from '../lib/exerciseMuscles';
import { layout, typography } from '../theme';

interface MuscleDetailsProps {
  /** The exercise's primaryMuscle field (e.g. "chest", "back", "rear delts"). */
  muscle: string;
  /** Optional sub-region emphasis from the exercise catalog. When set,
   *  the PRIMARY highlight uses this emphasis (either a native slug on
   *  a specific view or a custom overlay path); when unset, the
   *  primary falls back to muscleInfo[muscle].slug on its default view. */
  emphasis?: MuscleEmphasis;
}

// ── Sizing (mirrored from MuscleOverlay's library-internal constants) ──
const BODY_SCALE = 0.55;
const BODY_WIDTH_UNITS = 200;
const BODY_HEIGHT_UNITS = 400;
const BODY_WIDTH = BODY_WIDTH_UNITS * BODY_SCALE;
const BODY_HEIGHT = BODY_HEIGHT_UNITS * BODY_SCALE;
const VIEWBOX_FRONT = '0 0 724 1448';
const VIEWBOX_BACK = '724 0 724 1448';

// ── Stagger tuning ──
// Each next muscle enters this many ms after the previous one. Labels
// trail their muscle by LABEL_LAG so the eye sees the muscle light up
// first, then the name catches up.
const STAGGER_MS = 140;
const LABEL_LAG_MS = 60;
const PRIMARY_FADE_MS = 340;
const SUPPORTING_FADE_MS = 300;
const LABEL_FADE_MS = 280;
// Primary settle: fade brings scale from 0.96 up; a brief overshoot
// to 1.03 then settle to 1 encodes emphasis without a pulse loop.
const PRIMARY_SETTLE_UP_MS = 220;
const PRIMARY_SETTLE_DOWN_MS = 220;

/** Result of resolving a worked muscle to what to paint on the body. */
type BodyHighlight =
  | { kind: 'native'; view: 'front' | 'back'; slug: Slug }
  | { kind: 'overlay'; view: 'front' | 'back'; pathId: MusclePathId };

/** Resolve a worked muscle to (view, highlight). For the primary,
 *  emphasis wins (may swap view). For supporting, always the muscle's
 *  default view + native slug. Returns null when no valid highlight
 *  exists — the caller will still show the label. */
function resolveHighlight(
  key: string,
  info: MuscleInfo,
  role: MuscleRole,
  emphasis: MuscleEmphasis | undefined,
): BodyHighlight | null {
  if (role === 'primary' && emphasis) {
    const r = emphasisToRender(emphasis);
    if (r.kind === 'native') return { kind: 'native', view: r.view, slug: r.slug };
    return { kind: 'overlay', view: r.view, pathId: r.pathId };
  }
  if (info.slug) return { kind: 'native', view: info.view, slug: info.slug };
  return null;
}

export default function MuscleDetails({ muscle, emphasis }: MuscleDetailsProps) {
  const { colors } = useTheme();
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => { if (mounted) setReduceMotion(v); })
      .catch(() => { /* default false is fine */ });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', v => {
      setReduceMotion(v);
    });
    return () => { mounted = false; sub.remove(); };
  }, []);

  const worked = deriveWorkedMuscles(muscle);
  if (worked.length === 0) return null;

  // Primary's info is guaranteed by deriveWorkedMuscles (returns []
  // when the primary can't be resolved). The primary's rendered VIEW
  // is the canonical view — supporting muscles on the other view show
  // as label-only.
  const primaryInfo = getMuscleInfo(worked[0].key)!;
  const primaryHighlight = resolveHighlight(worked[0].key, primaryInfo, 'primary', emphasis);
  const canonicalView: 'front' | 'back' = primaryHighlight?.view ?? primaryInfo.view;

  const mutedTeal = colors.accentTeal + '99'; // ~60% alpha

  return (
    <View style={styles.container}>
      <View style={styles.diagramRow}>
        <View style={styles.figureCol}>
          {/* Base body — never fades. Provides the outline + the
              defaultFill that unhighlighted muscles sit at. */}
          <View style={styles.baseLayer}>
            <Body
              side={canonicalView}
              scale={BODY_SCALE}
              border="none"
              defaultFill={colors.surfaceElevated}
              data={[]}
            />
          </View>
          {/* Per-muscle highlight layers, stacked. Each one paints its
              own single muscle over the base and animates its opacity
              (+ scale for primary) in from the stagger delay. Layers
              whose view doesn't match the canonical one are skipped —
              label still shows below. */}
          {worked.map((w, i) => {
            const info = getMuscleInfo(w.key);
            if (!info) return null;
            const hl = resolveHighlight(w.key, info, w.role, emphasis);
            if (!hl || hl.view !== canonicalView) return null;
            return (
              <BodyHighlightLayer
                key={w.key}
                highlight={hl}
                color={w.role === 'primary' ? colors.accentTeal : mutedTeal}
                delay={i * STAGGER_MS}
                isPrimary={w.role === 'primary'}
                reduceMotion={reduceMotion}
              />
            );
          })}
        </View>
        <View style={styles.labelCol}>
          {worked.map((w, i) => {
            const info = getMuscleInfo(w.key);
            if (!info) return null;
            return (
              <MuscleLabel
                key={w.key}
                info={info}
                role={w.role}
                color={w.role === 'primary' ? colors.accentTeal : mutedTeal}
                roleColor={w.role === 'primary' ? colors.accentTeal : colors.textMuted}
                delay={i * STAGGER_MS + LABEL_LAG_MS}
                reduceMotion={reduceMotion}
              />
            );
          })}
        </View>
      </View>
      {/* Primary muscle's short description — unchanged behavior from
          the pre-piece-2 card, keeps the educational content the user
          may already expect. */}
      <Text style={[styles.name, { color: colors.textPrimary }]}>
        {primaryInfo.name}
      </Text>
      <Text style={[styles.description, { color: colors.textSecondary }]}>
        {primaryInfo.description}
      </Text>
    </View>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

interface BodyHighlightLayerProps {
  highlight: BodyHighlight;
  color: string;
  delay: number;
  isPrimary: boolean;
  reduceMotion: boolean;
}

function BodyHighlightLayer({
  highlight,
  color,
  delay,
  isPrimary,
  reduceMotion,
}: BodyHighlightLayerProps) {
  const opacity = useSharedValue(0);
  // Primary starts slightly small so its arrival can settle — see
  // withSequence in the effect below. Supporting muscles have no
  // scale animation; they hold at 1.
  const scale = useSharedValue(isPrimary ? 0.96 : 1);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reduceMotion) {
      opacity.set(1);
      scale.set(1);
      return () => { /* nothing to clean up */ };
    }
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      opacity.set(
        withTiming(1, {
          duration: isPrimary ? PRIMARY_FADE_MS : SUPPORTING_FADE_MS,
          easing: Easing.out(Easing.quad),
        }),
      );
      if (isPrimary) {
        // Single soft emphasis: overshoot 1.03 then settle to 1. Not a
        // loop, not a bounce — a one-time landing gesture.
        scale.set(
          withSequence(
            withTiming(1.03, { duration: PRIMARY_SETTLE_UP_MS, easing: Easing.out(Easing.quad) }),
            withTiming(1, { duration: PRIMARY_SETTLE_DOWN_MS, easing: Easing.out(Easing.quad) }),
          ),
        );
      }
    }, delay);
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [delay, isPrimary, reduceMotion, opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [{ scale: scale.get() }],
  }));

  const viewBox = highlight.view === 'front' ? VIEWBOX_FRONT : VIEWBOX_BACK;

  return (
    <Reanimated.View style={[styles.absoluteLayer, animatedStyle]} pointerEvents="none">
      {highlight.kind === 'native' ? (
        <Body
          side={highlight.view}
          scale={BODY_SCALE}
          border="none"
          defaultFill="transparent"
          data={[{ slug: highlight.slug, color }]}
        />
      ) : (
        <Svg width={BODY_WIDTH} height={BODY_HEIGHT} viewBox={viewBox}>
          <Path d={PATHS_BY_ID[highlight.pathId]} fill={color} />
        </Svg>
      )}
    </Reanimated.View>
  );
}

interface MuscleLabelProps {
  info: MuscleInfo;
  role: MuscleRole;
  color: string;
  roleColor: string;
  delay: number;
  reduceMotion: boolean;
}

function MuscleLabel({ info, role, color, roleColor, delay, reduceMotion }: MuscleLabelProps) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(6);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reduceMotion) {
      opacity.set(1);
      translateY.set(0);
      return () => { /* nothing to clean up */ };
    }
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      opacity.set(
        withTiming(1, { duration: LABEL_FADE_MS, easing: Easing.out(Easing.quad) }),
      );
      translateY.set(
        withTiming(0, { duration: LABEL_FADE_MS, easing: Easing.out(Easing.quad) }),
      );
    }, delay);
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [delay, reduceMotion, opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [{ translateY: translateY.get() }],
  }));

  return (
    <Reanimated.View style={[labelStyles.block, animatedStyle]}>
      <Text style={[labelStyles.name, { color }]} numberOfLines={1}>
        {info.name}
      </Text>
      <Text style={[labelStyles.role, { color: roleColor }]}>
        {role === 'primary' ? 'Primary mover' : 'Supporting'}
      </Text>
    </Reanimated.View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────
// All static — no theme dependency, so they live at module scope and
// don't need a makeStyles closure per render.

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
  figureCol: {
    width: 130,
    height: BODY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  labelCol: {
    flex: 1,
    justifyContent: 'center',
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
  absoluteLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  baseLayer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const labelStyles = StyleSheet.create({
  block: {
    marginBottom: layout.spacing.sm,
  },
  name: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    letterSpacing: -0.2,
  },
  role: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: 2,
  },
});
