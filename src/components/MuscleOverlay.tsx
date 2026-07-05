// MuscleOverlay — the production side of the muscle sub-region feature.
//
// Wraps react-native-body-highlighter's <Body> and (when the caller
// requests an overlay path) stacks a second <Svg> on top with a matched
// viewBox. The library ignores custom `path` fields on its `data` prop
// (confirmed by reading dist/index.js line 55–82 during the feasibility
// spike), so the only way to highlight a sub-region the library doesn't
// natively separate is via a parallel SVG. Coordinate systems align 1:1
// because both SVGs use the identical viewBox and rendered width×height.
//
// This component keeps the API narrow:
//   • `view`      — 'front' | 'back'; controls which body figure renders
//   • `highlight` — either a native slug (delegated to <Body>'s data
//                   prop) or a custom path (rendered by the overlay Svg).
//                   `null` means no highlight at all — the base figure
//                   renders in its default fill.
//   • `color`     — the highlight color. Callers pass colors.accentTeal;
//                   accent-discipline choices belong to the restyle, not
//                   this feature.
//   • `scale`     — matches <Body>'s scale; overlay Svg mirrors the
//                   library's `width = 200 × scale`, `height = 400 × scale`.
//   • `defaultFill` — same field the library exposes; passed through.
//
// See src/constants/musclePaths.ts for the authored path strings and
// src/lib/muscleEmphasis.ts for the emphasis → highlight mapping.

import React from 'react';
import { StyleSheet, View } from 'react-native';
import Body, { type Slug } from 'react-native-body-highlighter';
import Svg, { Path } from 'react-native-svg';
import { PATHS_BY_ID, type MusclePathId } from '../constants/musclePaths';
import { reportSilent } from '../lib/errorReporting';

// ── Library-internal constants ───────────────────────────────────────
//
// Mirrored from node_modules/react-native-body-highlighter/dist/
// components/SvgMaleWrapper.js line 40 — the wrapper's viewBox and its
// rendered size formula. If a future library version changes these, the
// overlay would silently misalign. package.json pins the library
// version to keep that from happening; a maintainer bumping the pin
// must re-verify these values.

const VIEWBOX_FRONT = '0 0 724 1448';
const VIEWBOX_BACK = '724 0 724 1448';
const BODY_WIDTH_UNITS = 200; // rendered width  = BODY_WIDTH_UNITS  × scale
const BODY_HEIGHT_UNITS = 400; // rendered height = BODY_HEIGHT_UNITS × scale

// ── Public types ─────────────────────────────────────────────────────

export type MuscleHighlight =
  | { kind: 'native'; slug: Slug }
  | { kind: 'overlay'; pathId: MusclePathId }
  | null;

export interface MuscleOverlayProps {
  view: 'front' | 'back';
  highlight: MuscleHighlight;
  color: string;
  scale?: number;
  defaultFill?: string;
}

export default function MuscleOverlay({
  view,
  highlight,
  color,
  scale = 0.55,
  defaultFill,
}: MuscleOverlayProps) {
  // Render guard: if the library ever throws (a bad slug after a future
  // upgrade, an svg-parse failure, etc.) we still want the surrounding
  // description text to appear. Matches MuscleDetails's existing pattern.
  let base: React.ReactNode = null;
  try {
    // When the highlight is native we pass the slug + color to the
    // library so it merges color onto its built-in path. When the
    // highlight is overlay OR null, `data=[]` tells the library to
    // render the figure without any built-in highlight — our own <Svg>
    // supplies the color in the overlay case.
    const bodyData =
      highlight && highlight.kind === 'native'
        ? [{ slug: highlight.slug, color }]
        : [];
    base = (
      <Body
        side={view}
        scale={scale}
        border="none"
        defaultFill={defaultFill}
        data={bodyData}
      />
    );
  } catch (e) {
    reportSilent(e, 'MuscleOverlay:body');
  }

  const bodyWidth = BODY_WIDTH_UNITS * scale;
  const bodyHeight = BODY_HEIGHT_UNITS * scale;
  const viewBox = view === 'front' ? VIEWBOX_FRONT : VIEWBOX_BACK;

  return (
    <View style={[styles.wrap, { width: bodyWidth, height: bodyHeight }]}>
      {base}
      {highlight && highlight.kind === 'overlay' && (
        <View
          style={styles.overlayLayer}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Svg width={bodyWidth} height={bodyHeight} viewBox={viewBox}>
            <Path d={PATHS_BY_ID[highlight.pathId]} fill={color} />
          </Svg>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Absolute-positioned overlay — same size as the wrapping View, so
  // the internal <Svg>'s viewBox aligns 1:1 with the base figure.
  overlayLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
