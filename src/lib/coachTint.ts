// Pure mapping from TrainingStatus state → coach-hero tint + ambient glow.
//
// The CoachVoiceHero re-lights its hero line by the user's current training
// state. Keeping the mapping in a pure helper means:
//   • The component is dumb — it only knows how to render two colors.
//   • The state→color contract is unit-testable without React.
//   • A future palette change (or a new TrainingStatusState) touches one file.
//
// Color choices (palette-aware, no new tokens):
//   recovering_well → accentTeal, bright glow — the cool "alive" state.
//   holding_steady  → textPrimary (pure warm white), soft amber glow — calm.
//   backing_off     → accentRest (calm indigo), dim glow — restrained, NOT
//                     red. Red stays destructive-only per src/theme.
//   unknown         → textSecondary (neutral slate), no glow — pre-calibration.
//
// `tint` is the hero TEXT color. `glow` is the ambient halo behind the panel
// (very low opacity at the render site); we return the BASE color and let the
// renderer apply the alpha so the same helper drives both a soft background
// glow and any future accent dot.
//
// Reads the frozen theme object directly — `theme` is a plain frozen value,
// not a hook, so coachTintFor stays pure and unit-testable.

import { theme } from '../theme';
import type { TrainingStatusState } from './trainingStatus';

export interface CoachTint {
  /** Hero text color. */
  tint: string;
  /** Ambient glow base color (renderer applies the alpha). */
  glow: string;
}

export function coachTintFor(state: TrainingStatusState): CoachTint {
  const { colors } = theme;
  switch (state) {
    case 'recovering_well':
      return { tint: colors.accentTeal, glow: colors.accentTeal };
    case 'holding_steady':
      return { tint: colors.textPrimary, glow: colors.accentAmber };
    case 'backing_off':
      return { tint: colors.accentRest, glow: colors.accentRest };
    case 'unknown':
    default:
      return { tint: colors.textSecondary, glow: colors.textSecondary };
  }
}
