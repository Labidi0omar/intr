# Claude Code prompt — Liftr/Intr Phase 2 (real-RN preview gate)

> DO NOT RUN until the Phase 1 checkpoint is committed and `git status` is clean.
> The agent must refuse to start on a dirty tree — that's the process fix from Phase 1.

---

You are doing **Phase 2 only**: build the proposed design system somewhere it can be viewed on a real device, touching **no production screen**. This is a gate. When you're done, a human runs the app and approves or sends notes. You do not proceed to Phase 3.

## Locked decisions (do not relitigate — full spec in `DESIGN_DIRECTION.md`)
- **Read `DESIGN_DIRECTION.md` first.** It is the taste spec. Do not invent visual direction beyond it.
- **Accent model:** one *action* accent (teal `#0EA5E9`) for buttons/active states only; coral/amber/emerald/red/indigo stay locked to encoded data meaning. Not single-accent. The preview demonstrates this discipline.
- **Corner radius: soft — 16px cards, 8px nested, 99px pills.** (Sharp was tried and rejected.)
- **Depth:** matte surface + 1px lit top edge + single soft shadow via `elevation` tokens. No blur, no heavy nested shadows (Android perf).
- **Signature moves:** (1) the semantic traffic-light on effort/status (Easy=emerald/Hard=amber/Max=red); (2) the lit-edge Surface card. Execute both consistently; keep everything else restrained.
- **Type:** Syne 700 headings, DM Sans 400/500 body; semantic scale 32/22/16/14/12/11 is the target (the Phase 1 `sNN` numeric scale is transitional debt, not the goal).
- Tokens already exist in `src/theme/index.ts` (Phase 1). Use them.

## Hard constraints (violate any → stop and report)
- **Touch no production screen.** No edits to `app/(tabs)/*`, `app/workout.tsx`, `app/onboarding.tsx`, etc. Production navigation must not depend on anything you add.
- **Real React Native.** No HTML mockup, no screenshot, no written description as a substitute. It must render truthfully on Android.
- **New, isolated, removable files only.** Everything you create lives under a clearly-named preview namespace (e.g. `app/_preview/` route + `src/components/preview/`) reachable only via a dev-only flag, never wired into the production tab bar. It must delete cleanly in one pass with zero production references left behind.
- **No new dependencies.** Existing stack only.
- **No gamification, no copy changes, no logic/data/edge-function/auth/payments changes.**
- Respect Android perf: no expensive blur, no heavy nested shadows, nothing that drops frames on mid-range devices.

## Build
1. **A dev-only preview route** behind a flag (e.g. gated on `__DEV__` + a constant), not added to the production tab navigator. Reachable for you to view, invisible/inert in production.
2. **Primitives gallery** rendering every core component and ALL its states with the approved system:
   - Button (primary / secondary / ghost; default / pressed / disabled / loading)
   - Input (default / focused / error / disabled)
   - Card / Surface (with and without tone)
   - List row (the pattern that has no shared component today — propose one here)
   - Header (propose the one consistent pattern)
   - Tab bar
   - Sheet / modal
   - Pill / chip (filter states)
   - The semantic-accent legend: show teal=action vs coral/amber/positive/red/rest=meaning, so the three-accent discipline is visible and reviewable.
3. **The workout execution screen, rebuilt with the new primitives** — the core loop, highest traffic, hardest surface. Rebuild it as a *preview copy* (new file under the preview namespace) that reuses the real screen's visual structure but **mocks/stubs all data and behavior** — no real Supabase calls, no navigation side effects, no logic. The point is to prove the system holds on the hardest screen, not to wire it up. Preserve the RIR effort-scale color semantics (Easy=emerald / Hard=amber / Max=red) — that's exactly the encoded meaning the three-accent decision protects.

## Verify before reporting
- `npx tsc --noEmit` clean.
- Confirm zero production files changed: `git diff --name-only` should list only preview-namespaced files (+ maybe a single flag constant).
- Confirm the preview route is unreachable from production navigation.

## Output
- Files created (all preview-namespaced) + how to reach the preview route in a dev build.
- Explicit confirmation: no production screen touched, no new deps, three accents preserved.
- **STOP.** State plainly: "Human gate — run the app on a device, view the preview, approve or send notes. Phase 3 does not begin without sign-off." Iterate only on the preview until approved.
```
