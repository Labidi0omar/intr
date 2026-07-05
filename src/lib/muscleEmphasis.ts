// Pure map: exercise-catalog "emphasis" → figure render instructions.
//
// The catalog carries an optional `emphasis?: MuscleEmphasis` on each
// exercise. When set, the muscle-figure card overrides its default
// per-muscle slug with a sub-region highlight:
//
//   • Five of the eight emphases resolve to a CUSTOM overlay path
//     (chest-upper, chest-lower, back-lats, shoulders-front,
//     shoulders-side). These paths are authored in
//     src/constants/musclePaths.ts and rendered by MuscleOverlay via
//     an <Svg> stacked over <Body> with matched viewBox.
//
//   • Three of the eight (back-traps, back-lower, shoulders-rear)
//     resolve to a NATIVE library slug — the audit found the library
//     already ships those on the appropriate view, so no overlay
//     authoring was needed. shoulders-rear specifically maps to the
//     back-view `deltoids` slug: from the back, the only visible
//     deltoid head IS the posterior head, so the native slug IS the
//     rear delt — trying to overlay a hand-authored polygon on top of
//     it only introduces alignment drift.
//
// Kept pure + free of React so it can be exercised by jest without a
// harness (see src/lib/muscleEmphasis.test.ts). The MuscleDetails
// component is the only production consumer.

import type { Slug } from 'react-native-body-highlighter';
import type { MusclePathId } from '../constants/musclePaths';

/** The 8-value union callers write into the exercise catalog. */
export type MuscleEmphasis =
  | 'chest-upper'
  | 'chest-lower'
  | 'back-lats'
  | 'back-traps'
  | 'back-lower'
  | 'shoulders-front'
  | 'shoulders-side'
  | 'shoulders-rear';

/** Result of resolving an emphasis to what the figure needs to draw. */
export type MuscleRender =
  | { view: 'front' | 'back'; kind: 'native'; slug: Slug }
  | { view: 'front' | 'back'; kind: 'overlay'; pathId: MusclePathId };

/**
 * Resolve an emphasis to a render decision. Pure and total: every
 * MuscleEmphasis literal is a key in the map, so the switch is
 * exhaustive by TypeScript's `never` check.
 *
 * back-traps and back-lower fall through to native slugs — no custom
 * overlay path exists for them because the library already ships
 * `trapezius` and `lower-back` as first-class slugs on the back view.
 */
export function emphasisToRender(emphasis: MuscleEmphasis): MuscleRender {
  switch (emphasis) {
    case 'chest-upper':
      return { view: 'front', kind: 'overlay', pathId: 'chest-upper' };
    case 'chest-lower':
      return { view: 'front', kind: 'overlay', pathId: 'chest-lower' };
    case 'back-lats':
      return { view: 'back', kind: 'overlay', pathId: 'back-lats' };
    case 'back-traps':
      return { view: 'back', kind: 'native', slug: 'trapezius' };
    case 'back-lower':
      return { view: 'back', kind: 'native', slug: 'lower-back' };
    case 'shoulders-front':
      return { view: 'front', kind: 'overlay', pathId: 'shoulders-front-delt' };
    case 'shoulders-side':
      return { view: 'front', kind: 'overlay', pathId: 'shoulders-side-delt' };
    case 'shoulders-rear':
      // Back-view deltoid slug IS the rear delt — no anterior or
      // lateral confusion, since those heads face forward. Delegating
      // to the native slug guarantees perfect alignment with the
      // built-in muscle geometry.
      return { view: 'back', kind: 'native', slug: 'deltoids' };
    default: {
      // Exhaustiveness check — a new emphasis literal without a case
      // becomes a compile error here.
      const exhaustive: never = emphasis;
      throw new Error(`Unhandled emphasis: ${exhaustive as string}`);
    }
  }
}
