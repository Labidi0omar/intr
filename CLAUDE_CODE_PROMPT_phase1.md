# Claude Code prompt — Liftr/Intr Phase 1 (tokens: enforce, don't recreate)

> Paste into Claude Code from the repo root. Do NOT run until §4 of `PHASE0_AUDIT.md` (one vs three accents) is decided — fill the DECISION line below first.

---

**DECISION (fill in before running):** Accent model = `[ KEEP 3 semantic accents / GO single-accent ]`

---

You are doing **Phase 1 only** of a UI systematization pass on this React Native + Expo app. Phase 1 is plumbing: make the app fully token-driven with **no intended visual change**. Read `PHASE0_AUDIT.md` in the repo root first — it is the source of truth for findings.

## Hard constraints (violate any → stop and report)
- **Presentation layer only.** Do not touch logic, state, data flow, Supabase/edge-function calls, navigation, or any behavior.
- **No visual change is intended.** Every token you introduce must resolve to the *same pixel value* currently rendered. If a literal can't map to a token without shifting the look, widen the token scale to include that value — do not round it to an existing step.
- **No new dependencies.** No component libraries. Use the existing `StyleSheet` + `src/theme/index.ts` approach.
- **No copy, no IA, no gamification, no "while I was in there" changes.**
- Out of scope entirely: auth, payments/RevenueCat, journal free-text, AI/edge-function code.

## Tasks (in order)
1. **Extend `src/theme/index.ts`** to cover real usage the audit found:
   - Widen the **type scale** to fit the 23 literal `fontSize` values in use (≈10 steps) instead of forcing them into 6. Name them on the existing `typography.size` object.
   - Widen the **radius scale** to fit the literal `borderRadius` values in use (don't drop 2/3/12/etc. on the floor).
   - Add an **easing** token under `animation` (the durations already exist; pick one easing curve and a spring config, document them).
   - Keep `deepFreeze`. Keep the existing token names working — additive only.
   - Apply the **DECISION** above to the accent comments/tokens. If KEEP 3: leave accents as-is, just document the rule. If single-accent: add the new token but **do not yet restyle screens** — Phase 1 only introduces it.
2. **Route literals to tokens, mechanically:** replace hardcoded `fontSize`, `borderRadius`, hex/rgba colors, and inline `shadowOpacity/shadowRadius/elevation` with the matching token. Each replacement must be value-identical. The audit lists the offender files (workout, home, profile, ShareCard, welcome, TabLayout, Surface).
3. **Reconcile the read pattern (I-3):** pick ONE of `useTheme()` or direct `theme` import as the convention, convert the codebase to it, and fix the now-stale line in `CLAUDE.md` that claims "there is no theme hook or context."
4. **Use the elevation tokens** in `Surface.tsx` and the 3 other inline-shadow sites instead of hand-rolled shadow values.

## Verify before reporting
- `npx tsc --noEmit` passes.
- `npm run lint` passes.
- Diff review: confirm every changed value is pixel-identical to before (grep the old literals, confirm the token resolves to the same number). List any literal you could NOT map without a visual shift — do not change those; report them.

## Output
- Files touched + summary per task.
- A table of "literal → token" mappings for fontSize and borderRadius.
- Explicit confirmation that no behavior and no intended visual changed.
- **Stop. Do not start Phase 2.** Phase 2 (the RN preview) is gated on human approval of this checkpoint.
