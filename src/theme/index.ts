// ═══════════════════════════════════════════════
// Intr Design System — Obsidian, mechanical, athletic.
// Data-dense, layered dark cards, semantic accents.
//
// SEMANTIC PALETTE — enforce on new surfaces:
//   accentTeal     → primary actions, volume/count metrics, "doing" CTAs
//   accentCoral    → streak / energy / heat / time-persistence
//   accentAmber    → ratios, percentages, achievements (PRs)
//   accentRed      → destructive only (delete, sign-out warnings)
//   accentPositive → low-effort success (RIR "easy", reps in tank)
//   accentRest     → rest / recovery / backing-off (deliberately NOT red)
//
// PHASE-1 DECISION (2026-06-30): KEEP three+ semantic accents.
// The accents encode meaning (action vs energy vs PR vs rest); the
// dashboard reads workout state by color. Do NOT reach for teal for a
// non-action stat — pick coral/amber by category. Single-accent collapse
// was considered and rejected: it would delete a layer of information
// the UI uses to tell training state apart at a glance.
//
// HOW TO READ TOKENS (Phase-1 convention):
//   colors                → `const { colors } = useTheme()` (semantic, may
//                           evolve; could one day support light theme).
//   typography / layout / → direct named imports from '@/src/theme'.
//   elevation / animation   These are frozen design constants — no need
//   / text                  to thread them through context.
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
//
// Two scales live on `size`:
//   1. Semantic aliases (xxs…xl) — original 6-step scale, preserved for
//      every existing call site.
//   2. Numeric tokens (s9…s64) — one entry per literal `fontSize` value
//      observed in app/+src/. Pixel-named so the mapping is unambiguous
//      and any future audit can verify "literal N → size.sN" mechanically.
// Decimals get an underscore separator: 9.5 → `s9_5`.

export const typography = deepFreeze({
  family: {
    heading: 'Syne_700Bold',
    body: 'DMSans_400Regular',
    bodyMedium: 'DMSans_500Medium',
  },
  size: {
    // Semantic aliases (legacy — do not remove)
    xl: 32,
    lg: 22,
    md: 16,
    sm: 14,
    xs: 12,
    xxs: 11,

    // Numeric scale — every fontSize literal in the app maps here.
    s9: 9,
    s9_5: 9.5,
    s10: 10,
    s10_5: 10.5,
    s11: 11,
    s11_5: 11.5,
    s12: 12,
    s12_5: 12.5,
    s13: 13,
    s13_5: 13.5,
    s14: 14,
    s15: 15,
    s16: 16,
    s17: 17,
    s18: 18,
    s19: 19,
    s20: 20,
    s22: 22,
    s24: 24,
    s26: 26,
    s28: 28,
    s30: 30,
    s32: 32,
    s40: 40,
    s52: 52,
    s56: 56,
    s64: 64,
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
//
// `radii` mirrors the typography numeric scale: one entry per literal
// `borderRadius` value observed in app/+src/. Semantic aliases
// (cardRadius / smRadius / pillRadius) are kept for clarity at the call
// site and continue to work unchanged.

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
  radii: {
    r1_5: 1.5,
    r2: 2,
    r2_5: 2.5,
    r3: 3,
    r4: 4,
    r5: 5,
    r6: 6,
    r8: 8,
    r11: 11,
    r12: 12,
    r14: 14,
    r16: 16,
    r18: 18,
    r20: 20,
    r28: 28,
    r32: 32,
    r60: 60,
    pill: 99,
  },
});

// ─── Elevation — shadow tokens for card depth ──
//
// Original three (card / floating / sheet) plus four new tokens that
// match values previously inlined in components. Naming convention:
// describe the *role*, not the size — keeps call sites readable.

export const elevation = deepFreeze({
  // Level 1 — default cards (stat cards, basic surfaces)
  card: {
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  // Level 2 — floating elements (modals, overlays, hero)
  floating: {
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  // Level 3 — top-level sheets (bottom sheets, full modals)
  sheet: {
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  // Signature Surface panel — slightly softer than `floating`,
  // shipping value from Surface.tsx before tokenization.
  panel: {
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  // Surface tone-glow — iOS-only halo behind the panel, no Android
  // elevation (intentional: Android renders the glow via the panel itself).
  glow: {
    shadowOpacity: 0.6,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
  },
  // Tiny lift for active pill chips / segmented controls.
  subtle: {
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  // Floating circular button over imagery (workout exercise photo controls).
  button: {
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});

// ─── Text style presets ────────────────────────
// Use these instead of re-deriving family+size+letterSpacing inline.
// Spread into a style object: { ...theme.text.heading1 }

export const text = deepFreeze({
  heading1: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    lineHeight: typography.lineHeight.tight,
    letterSpacing: typography.size.xl * typography.letterSpacing.heading,
  },
  heading2: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    lineHeight: typography.lineHeight.tight,
    letterSpacing: typography.size.lg * typography.letterSpacing.heading,
  },
  body: {
    fontFamily: typography.family.body,
    fontSize: typography.size.md,
    lineHeight: typography.lineHeight.body,
  },
  bodyMedium: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.md,
    lineHeight: typography.lineHeight.body,
  },
  caption: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    lineHeight: 20,
  },
  label: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.xxs,
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
  },
});

// ─── Animation ─────────────────────────────────
//
// `easing.*` are 4-tuples of cubic-bezier control points. Consumers spread
// them into RN's `Easing.bezier(...)` at the call site (and Reanimated's
// equivalent), e.g.
//   import { Easing } from 'react-native';
//   Easing.bezier(...animation.easing.standard)
// This indirection keeps the theme module side-effect-free so non-React
// code paths (and Jest) can import it without pulling in react-native.
//
// `standard` is the project's house curve — soft material-style ease.
//
// `spring.*` are intent-named presets — pick by feel, not by number:
//   press   — snappy, low-mass; press/scale feedback on buttons, cards.
//   default — the project's original spring; general physical motion.
//   gentle  — soft and slower; ambient state transitions (e.g. training
//             status color/scale shifts) where a snap would feel harsh.
// `stagger` is the delay (ms) between successive entering animations
// in a list — used by the MOTION.enter helper in src/components/motion.

export const animation = deepFreeze({
  duration: {
    hover: 150,
    transition: 250,
    progress: 600,
  },
  easing: {
    standard: [0.4, 0, 0.2, 1] as const,
    decelerate: [0, 0, 0.2, 1] as const,
    accelerate: [0.4, 0, 1, 1] as const,
  },
  spring: {
    press:   { stiffness: 400, damping: 28, mass: 0.7 },
    default: { stiffness: 200, damping: 22, mass: 1 },
    gentle:  { stiffness: 120, damping: 20, mass: 1 },
  },
  stagger: 55,
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
  accentRest: string;         // Rest / recovery / backing-off — calm indigo,
                              // deliberately NOT red. Red stays destructive-only.

  // Tactical grid & inputs
  border: string;             // Hard mechanical grid lines
  borderActive: string;       // Highlighted boundaries
  sliderTrack: string;        // Recessed input channels

  // Pure monochromatic typography
  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  // Utility overlay colors used by modals, scrims and shadows.
  // Centralized here so the four-or-five rgba(0,0,0,…) literals that
  // were scattered across screens can resolve through one place.
  scrimSoft: string;          // rgba(0,0,0,0.5)
  scrimMedium: string;        // rgba(0,0,0,0.6)
  scrimStrong: string;        // rgba(0,0,0,0.7)
  scrimHeavy: string;         // rgba(0,0,0,0.75)
  scrimDeep: string;          // rgba(0,0,0,0.85) — share-preview overlay
  shadowColor: string;        // '#000' — for shadowColor only
};

export type IntrTheme = {
  colors: IntrColors;
  typography: typeof typography;
  layout: typeof layout;
  elevation: typeof elevation;
  text: typeof text;
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
  accentRest: '#818CF8',     // Calm indigo — rest / recovery / backing-off (NOT red)

  // Grid & inputs
  border: '#22262A',
  borderActive: '#3A4654',
  sliderTrack: '#0D0F11',

  // Typography
  textPrimary: '#FFFFFF',
  textSecondary: '#94A3B8',
  textMuted: '#475569',

  // Overlays / shadows
  scrimSoft: 'rgba(0,0,0,0.5)',
  scrimMedium: 'rgba(0,0,0,0.6)',
  scrimStrong: 'rgba(0,0,0,0.7)',
  scrimHeavy: 'rgba(0,0,0,0.75)',
  scrimDeep: 'rgba(0,0,0,0.85)',
  shadowColor: '#000',
};

export const theme: IntrTheme = deepFreeze({
  colors: { ...PALETTE },
  typography,
  layout,
  elevation,
  text,
  animation,
});
