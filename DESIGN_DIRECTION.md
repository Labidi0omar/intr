# Liftr / Intr — DESIGN DIRECTION (locked)

The filled-in direction block the brief required before any restyle. Decided with Omar via mockup review. This is the taste spec every phase references; the agent does not invent beyond it.

## Base palette
Obsidian dark, single theme (no light mode). Layered surfaces:
- `background` `#070708` (canvas)
- `surface` `#141619` (card)
- `surfaceElevated` `#1A1D21` (active / nested)
- `cardBorder` `rgba(255,255,255,0.06)` (hairline)
- Text: `#FFFFFF` / `#94A3B8` / `#475569` (primary / secondary / muted)

## Accent model — one action accent + locked semantics (NOT single-accent)
- **Action accent: teal `#0EA5E9`** — the *only* color used for primary actions and active/selected states. If it's a button, a "logging" state, a progress fill, or the current tab, it's teal. Nothing else is teal.
- **Semantic set — used ONLY to encode data meaning, never decoration:**
  - coral `#F43F5E` — streak / energy / heat
  - amber `#F59E0B` — PR / ratio / achievement / training-status "holding"
  - emerald `#10B981` — easy effort / reps in the tank / completed
  - red `#EF4444` — max effort / destructive
  - indigo `#818CF8` — rest / recovery (deliberately never red)
- Rule: reaching for a semantic color for a non-semantic surface is a bug. The discipline *is* the identity.

## Typeface
- Display / headings: **Syne 700** (`Syne_700Bold`)
- Body: **DM Sans** 400 / 500 (`DMSans_400Regular` / `DMSans_500Medium`)
- Both already loaded via expo-google-fonts — RN-native, no new dependency.

## Type scale
- Base body 16px. Canonical semantic scale: **32 / 22 / 16 / 14 / 12 / 11** (xl…xxs).
- The 27-value numeric `sNN` scale introduced in Phase 1 is *transitional plumbing*, not the target. Over Phase 3, screens collapse toward the semantic scale; half-pixel steps (`s9_5`, `s13_5`) are debt to retire, not tokens to build on.

## Corner radius personality
**Soft.** 16px cards, 8px nested elements, 99px pills. (Sharp/near-square was tried and rejected — it fought the calm, restrained tone.)

## Depth approach
**Layered surfaces, restrained.** Matte fill + a 1px lit top edge (`rgba(255,255,255,0.06)`) + a single soft drop shadow. No blur, no heavy nested shadows, nothing that drops frames on mid-range Android. Use the `elevation` tokens, not hand-rolled shadows.

## Motion personality
**Snappy & minimal.** 150ms for hover/press feedback, 250ms for transitions, 600ms only for deliberate progress fills. One standard easing curve, applied everywhere (no per-screen improvisation).

## Signature moves (max 2 — the repeated things that make it Liftr)
1. **Semantic traffic-light for effort and state.** The RIR selector (Easy=emerald / Hard=amber / Max=red) and Training Status (green/amber/red) read as instant color-coded meaning with no reading required. This is the one place multiple accents appear together, and it's load-bearing, not decorative.
2. **The lit-edge Surface card.** Every signature panel is matte fill with a single 1px `rgba(255,255,255,0.06)` top highlight — "lit from above." Consistent across every card; that consistency is the polish.

Everything else stays restrained. Uniqueness comes from executing these two moves consistently, not from making each screen different.
