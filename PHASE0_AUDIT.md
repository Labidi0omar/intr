# Liftr / Intr — Phase 0 Design System Audit

**Scope:** Read-only inventory. No code changed. Establishes the identity the restyle must preserve (or, if you choose, knowingly replace).

> Naming note: the brief calls the app **Liftr**; the codebase, theme header, and types all say **Intr** (`IntrColors`, `IntrTheme`, "Intr Design System"). Not a design issue, but decide which name is canonical before any copy/asset work — flagging, not touching (copy is out of scope).

---

## 1. Tokens that already exist (`src/theme/index.ts`)

The app is **already token-driven at the source**. `theme` is `deepFreeze`d and exposed two ways: a direct import and a `useTheme()` context that returns the same frozen object. This is not a greenfield token job — it's a *finish-and-enforce* job.

| Group | Token | Value |
|---|---|---|
| **Canvas** | `background` | `#070708` |
| | `surface` | `#141619` |
| | `surfaceElevated` | `#1A1D21` |
| | `cardBorder` | `rgba(255,255,255,0.06)` |
| **Accents (semantic)** | `accentTeal` | `#0EA5E9` — primary actions / volume / count |
| | `accentCoral` | `#F43F5E` — streak / energy / heat |
| | `accentAmber` | `#F59E0B` — ratios / % / PRs |
| | `accentRed` | `#EF4444` — destructive only |
| | `accentPositive` | `#10B981` — RIR "easy" / reps in tank |
| | `accentRest` | `#818CF8` — rest / backing-off (deliberately not red) |
| **Grid / inputs** | `border` `borderActive` `sliderTrack` | `#22262A` / `#3A4654` / `#0D0F11` |
| **Text** | `textPrimary` `textSecondary` `textMuted` | `#FFFFFF` / `#94A3B8` / `#475569` |
| **Type family** | heading / body / bodyMedium | Syne_700Bold / DMSans_400 / DMSans_500 |
| **Type scale** | xl/lg/md/sm/xs/xxs | **32 / 22 / 16 / 14 / 12 / 11** (6 steps) |
| **Line height** | body / tight | 1.65 / 1.25 |
| **Radii** | cardRadius / smRadius / pillRadius | **16 / 8 / 99** (3 steps) |
| **Spacing** | xs/sm/md/lg/xl/xxl | 8 / 12 / 16 / 24 / 32 / 48 |
| **Elevation** | card / floating / sheet | 3 defined shadow presets |
| **Text presets** | heading1/2, body, bodyMedium, caption, label | composed styles |
| **Motion** | hover / transition / progress | 150 / 250 / 600 ms (no easing token) |

---

## 2. Core component patterns

| Component | Source | Pattern | Notes |
|---|---|---|---|
| Button | `src/components/Button.tsx` | 3 variants (primary/secondary/ghost), `Pressable`, pressed-opacity | Centralized ✅ |
| Input | `src/components/Input.tsx` | label + field + error, focus/error border swap | Centralized ✅ |
| Card / panel | `src/components/Surface.tsx` | matte fill, 1px lit top edge, drop shadow, optional `tone` glow | The intended "signature" card — **not yet adopted everywhere** (comment admits stat cards still need migration) |
| List row | — | **No shared component.** Rolled by hand per screen | Inconsistency source |
| Header | — | **No shared component.** Each screen builds its own | Inconsistency source |
| Tab bar | `src/components/TabLayout.tsx` | custom nested tab layout | Has 1 hardcoded hex |
| Sheet / modal | — | **No shared component.** Modals built inline per screen | Inconsistency source |
| Pill / chip | `src/components/PillFilter.tsx` | filter pills | Centralized ✅ |

**Takeaway:** primitives that *have* a component (button, input, pill, surface) are clean. The drift lives in the things with **no shared primitive** — rows, headers, modals — which every screen re-invents.

---

## 3. Inconsistencies (the real Phase 1 backlog)

| # | Finding | Evidence | Severity |
|---|---|---|---|
| I-1 | **Type scale ignored.** Theme defines 6 sizes; code uses **23 distinct literal `fontSize` values** (9→64). Off-scale values 13, 10, 9, 15, 17, 19 are among the *most common* (fontSize:13 appears 34×, :10 29×, :9 7×). | `grep fontSize` across `app/`+`src/` | **High** |
| I-2 | **Radius scale ignored.** Theme defines 3 radii (16/8/99); code uses **16 distinct literal `borderRadius` values** (1→60). Most common are 3 (9×) and 2 (7×) — neither is a token. | `grep borderRadius` | **High** |
| I-3 | **Two ways to read the same tokens.** 25 files use `useTheme()`, 24 import `theme` directly. Both return the identical frozen object, so it's harmless at runtime but it's a split convention. **`CLAUDE.md` actively says "there is no theme hook or context" — that doc is stale.** | `grep useTheme` vs `from '…theme'` | Medium |
| I-4 | **Elevation tokens bypassed.** `elevation.{card,floating,sheet}` exist, but `Surface.tsx` and 3 other call sites hardcode their own `shadowOpacity`/`shadowRadius`/`elevation` inline. | `grep shadowOpacity` (4 inline) | Medium |
| I-5 | **Stray hex / rgba literals.** Hardcoded colors outside the token file: `ShareCard` (8), `welcome` (5), `workout` (2), `profile`, `Surface`, `TabLayout`. rgba literals in `workout` (5), `profile` (3), `home` (1). | `grep hex/rgba` | Medium (contained) |
| I-6 | **No easing token.** Motion has durations but no easing curve, so every animated screen picks its own — inconsistent feel. | `theme.animation` | Low |
| I-7 | **Letter-spacing / uppercase done by hand.** Button uses `letterSpacing: 0.5`, Input uses `1`, theme `label` preset uses `2`. Three different "uppercase label" treatments. | component styles | Low |

---

## 4. The contradiction you have to resolve before Phase 1

Your `DESIGN DIRECTION` template demands **"exactly one accent color, used sparingly."** The existing identity is built on **three semantic accents on purpose** — the theme file argues against collapsing them in writing: *"The whole point of three accents is narrative variety."* The accents aren't decoration; they're **encoded meaning** (teal=action, coral=energy, amber=PR/ratio, plus positive/rest/red). Collapsing to one accent isn't a restyle — it deletes a layer of information the UI currently uses to tell workout state apart at a glance.

You cannot both "preserve the identity" (Phase 0's stated goal) and "use exactly one accent." Pick:

- **(A) Keep semantic accents, systematize them** — rewrite the template's accent line to "one *primary action* accent (teal) + a fixed semantic set used only for data meaning." This is the honest "preserve + clean" pass. *Recommended* unless you have a real reason to flatten meaning.
- **(B) Go single-accent** — then say plainly this is a visual-language *redesign*, and Phase 0 documents what you're *replacing*. Expect to also redesign how the dashboard distinguishes states (color was doing that work).

---

## 5. Scope reality for Phase 3 (flagging early, not acting)

The core-loop screens are enormous single files: **`workout.tsx` 3,983 lines**, `home.tsx` 3,038, `profile.tsx` 2,113. The brief's "one screen per pass, don't batch" rule is correct, but be aware: restyling `workout.tsx` is itself a multi-day pass, not an afternoon. The Phase 2 preview rebuilding the workout execution screen with new primitives is the right forcing function — it'll prove the system on the hardest surface before you touch the 3,983-line original.

---

## 6. What I recommend as Phase 1 (no code yet — your call to greenlight)

1. **Settle §4** (one vs three accents) — this is yours, and nothing downstream is coherent until it's decided.
2. Add the two missing token groups the audit proves are needed: a fuller **type scale** (the code clearly needs ~10 steps, not 6) and a fuller **radius scale**, plus an **easing** token. Better to widen the scale to match real need than to force 23 sizes into 6 and fight every screen.
3. **Enforce, don't recreate:** route literal `fontSize`/`borderRadius`/hex/shadow values to the existing tokens. Mechanical, reversible, no intended visual change — exactly the Phase 1 checkpoint the brief describes.
4. Reconcile **I-3**: pick `useTheme()` *or* direct import as the one convention, and fix the stale `CLAUDE.md` line.

This stays inside every hard constraint: presentation only, no IA change, no new deps, no gamification, fully reversible.
