// ═══════════════════════════════════════════════
// Intr Design System — Obsidian, mechanical, athletic.
// Data-dense, layered dark cards, semantic accents.
//
// SEMANTIC PALETTE — enforce on new surfaces:
//   accentTeal   → primary actions, volume/count metrics, "doing" CTAs
//   accentCoral  → streak / energy / heat / time-persistence
//   accentAmber  → ratios, percentages, achievements (PRs)
//   accentRed    → destructive only (delete, sign-out warnings)
//
// If you reach for teal for a non-action stat, stop and pick coral or
// amber by category. The whole point of three accents is narrative variety.
// ═══════════════════════════════════════════════

function deepFreeze<T extends Record<string, any>>(obj: T): T {
  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

// ─── Typography ───────────────────────────────

export const typography = deepFreeze({
  family: {
    heading: 'Syne_700Bold',
    body: 'DMSans_400Regular',
    bodyMedium: 'DMSans_500Medium',
  },
  size: {
    xl: 32,
    lg: 22,
    md: 16,
    sm: 14,
    xs: 12,
    xxs: 11,
  },
  lineHeight: {
    body: 1.65,
    tight: 1.25,
  },
  letterSpacing: {
    heading: -0.02,
    wide: 0.06,
    mono: -0.04,
  },
});

// ─── Layout — premium dashboard card system ──

export const layout = deepFreeze({
  cardRadius: 16,            // Consistent sleek card rounding
  pillRadius: 99,            // For mini chips / badges
  smRadius: 8,               // Small nested elements
  borderWidth: 1,            // Global structural line weight
  spacing: {
    xs: 8,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },
});

// ─── Animation ─────────────────────────────────

export const animation = deepFreeze({
  duration: {
    hover: 150,
    transition: 250,
    progress: 600,
  },
});

// ─── Flat color token type ─────────────────────

export type IntrColors = {
  // Canvas & Cards — layered depth
  background: string;
  surface: string;            // Card surface that floats over canvas
  surfaceElevated: string;    // Hovered / active / selected state
  cardBorder: string;         // Ultra-thin translucent card boundary

  // High-vibrancy semantic accents
  accentTeal: string;         // Primary actions — electric slate-blue / teal
  accentCoral: string;        // Streaks / energy metrics — fiery coral
  accentAmber: string;        // Achievements / PRs — premium gold
  accentRed: string;          // Destructive / missed targets
  accentPositive: string;     // Successful low-effort signals — emerald green
                              // (e.g. RIR "Easy" chip; reps left in the tank)

  // Tactical grid & inputs
  border: string;             // Hard mechanical grid lines
  borderActive: string;       // Highlighted boundaries
  sliderTrack: string;        // Recessed input channels

  // Pure monochromatic typography
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
};

export type IntrTheme = {
  colors: IntrColors;
  typography: typeof typography;
  layout: typeof layout;
  animation: typeof animation;
};

// ─── Single obsidian premium theme ─────────────

const PALETTE: IntrColors = {
  // Canvas & card layers
  background: '#070708',
  surface: '#141619',
  surfaceElevated: '#1A1D21',
  cardBorder: 'rgba(255,255,255,0.06)',

  // Semantic accents
  accentTeal: '#0EA5E9',     // Vibrant electric blue-teal — primary CTAs
  accentCoral: '#F43F5E',    // Fiery coral — streak / energy metrics
  accentAmber: '#F59E0B',    // Premium amber-gold — PRs / achievements
  accentRed: '#EF4444',      // Sharp red — destructive / missed
  accentPositive: '#10B981', // Emerald — RIR Easy chip, "you had more in the tank"

  // Grid & inputs
  border: '#22262A',
  borderActive: '#3A4654',
  sliderTrack: '#0D0F11',

  // Typography
  textPrimary: '#FFFFFF',
  textSecondary: '#94A3B8',
  textMuted: '#475569',
};

export const theme: IntrTheme = deepFreeze({
  colors: { ...PALETTE },
  typography,
  layout,
  animation,
});