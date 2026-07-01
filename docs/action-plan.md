# Intr — Action Plan (Kofi's ranking, made executable)

This is the do-list, in order. Each item has: **why** it's here, **where** it touches the code,
and **done =** the acceptance bar. Don't jump ahead — the ordering is the point. Data before
features, fast-and-visible before more.

Legend: 🔴 blocks launch / proves the core · 🟠 before public launch · 🟢 phase 2 (after the core
proves it retains)

---

## 🔴 PHASE 0 — DO NOW (make the loop fast, visible, and in front of users)

### 1. Rest timer (with wrist-haptic later)
- **Why:** Table stakes. A lifting app that doesn't time the 90s between sets isn't a lifting
  app. Its absence is disqualifying in reviews. Research shows haptic rest timers are standard in
  every serious strength app.
- **Where:** `app/workout.tsx` active phase. There's already a `showRestNotice` + 60s timeout
  stub (`hideRestTimeout`) — replace it with a real countdown driven by the current exercise's
  `restSeconds`, auto-started after a set is logged, with a visible count and a local
  notification when it ends.
- **Done =** after logging a set, a countdown from the exercise's `restSeconds` shows and ticks;
  it fires a notification/haptic at zero; user can skip or +15s. Verified on device.

### 2. "Coach was right" — personal effort-trend surface
- **Why:** The single most unique, on-thesis retention hook. It makes the invisible engine
  visible and is the one thing no competitor can show. Runs on data you already collect.
- **Where:** Progress tab (`app/(tabs)/progress.tsx`) and/or the completion screen in
  `workout.tsx`. Read from `prescription_outcome` events / `exercise_logs` + `reps_in_reserve`.
- **Critical constraint:** Show the user their own RAW trend ("you hit your target effort zone
  9 of your last 11 sessions"). Do NOT make a causal claim ("the coach made you stronger") — the
  efficacy metric is selection-biased and can't support causation.
- **Done =** a user with history sees an honest, non-causal effort-zone trend; a new user sees a
  sensible empty state.

### 3. First-workout-before-full-signup onboarding
- **Why:** Highest-ROI day-1 retention change in the research. Activation = finishing the first
  workout; target is the "do this workout now" moment in **under ~90 seconds**. 82% of trial
  decisions happen on install day, so day-0 value is everything.
- **Where:** onboarding flow (`app/onboarding.tsx`, `app/welcome.tsx`, session guard in
  `app/index.tsx`). Let the user reach a real first session with minimal taps; defer full profile
  capture until after they've felt value.
- **Done =** a fresh install can start a real workout in under ~90 seconds without completing full
  profile setup; profile is back-filled afterward.

### 4. Ship the engine FREE to a small cohort and watch the data
- **Why:** The paywall is worthless until you know people return for the prescriptions. Validate
  retention + efficacy before monetizing. This is the gate for Phase 1.
- **Where:** keep `tier` effectively free for now; rely on the `events` table, `metrics_cohorts`,
  and `metrics_prescription_efficacy` views.
- **Watch:** D7/D30 return rate, % of sessions with RIR logged, prescription follow rate,
  effort-zone trend over time. Treat the efficacy delta as a signal to investigate, NOT proof.
- **Done =** a small real cohort is using it and you have ≥2–3 weeks of retention + efficacy data
  to decide whether the core is worth monetizing.

### 5. Home-screen widget
- **Why:** Cheap, high-leverage, persistent re-engagement. Anchors the app to the device. Strong
  and Ladder both ship streak/activity widgets.
- **Where:** new native widget (iOS WidgetKit / Android), reads cached plan + streak from the
  data you already store in AsyncStorage/Supabase.
- **Done =** widget shows today's session + current streak and deep-links into the app.

---

## 🟠 PHASE 1 — BEFORE PUBLIC LAUNCH (kill objections, then monetize what's proven)

### 6. CSV / data export
- **Why:** Reddit explicitly distrusts apps that trap data. Cheapest goodwill there is; kills a
  recurring 1-star objection before it appears.
- **Where:** Profile/settings; export `workout_sessions` + `exercise_logs` to CSV via
  `expo-sharing` (already a dependency).
- **Done =** user can export their full log to a CSV file from inside the app.

### 7. The money path (build ONLY after #4 shows people return)
- **Why:** This is the business, but pricing/feature-gating on zero willingness-to-pay data is a
  guess. Sequence it after validation.
- **Sub-steps:**
  - Wire real RevenueCat keys (`src/lib/purchases.ts` — currently empty strings).
  - Build the paywall screen (referenced as "Sprint 6" but doesn't exist).
  - Replace the hardcoded `tier = "free"` in `supabase/functions/replan-today/index.ts` with a
    real entitlement check (RC webhook → `subscriptions` table the edge fn reads).
  - **Trial length: ~17–32 days, NOT 7.** Data shows ~46% vs ~27% conversion. Structured
    onboarding → trial paywall is the top-performing config.
  - Freemium split: free = logging, manual plans, basic history; Pro = autoregulation engine,
    AI replanner beyond a small monthly cap, advanced analytics, deload alerts.
  - Pricing: treat any number as a hypothesis to test, not a fixed truth. Don't hard-anchor.
- **Done =** a user can subscribe, the entitlement actually gates the engine server-side, and the
  trial is correctly length-tuned.

### 8. Cleanup batch
- **Why:** Real liabilities, all cheap.
- **Items:**
  - Fix `fontVariantNumeric` in the 3 style blocks (`sessionExSetsReps` in `workout.tsx`,
    `weekDayExerciseText` in `home.tsx`, `weightCurrent` in `profile.tsx`) — it's an invalid RN
    style prop. Use a monospace font / `tabular-nums` via fontFeatureSettings or just remove it.
  - Reconcile the docs: `docs/schema.md`/`CLAUDE.md` still say "Flux", reference a phantom
    `generate-plan` edge function and `checkin.tsx`/`plan.tsx` that don't exist. Align to reality.
  - Make energy-5 target picker classifier-based (`classifyCompoundness`) instead of positional,
    so the "add sets to compounds" guarantee is intrinsic, not dependent on session ordering.
  - Energy-3 path: shallow-clone the exercises array so all energy levels behave consistently
    (avoid the by-reference mutation trap).
  - **Revoke and rotate the Anthropic key** that was committed in `supabase/functions/.env` with
    an `EXPO_PUBLIC_` prefix (from the original audit). Confirm `.env` files are gitignored.
  - Add unit tests for any remaining untested pure logic touched along the way.

---

## 🟢 PHASE 2 — THE DURABLE MOAT (only after the core proves it retains)

### 9. Volume landmarks → living mesocycle + meaningful deload alerts
- **Why:** The structural reason a user is still here in month 3. Turns the plan from a weekly
  reshuffle into a progressing program (MEV → add a set/week → MRV → auto-deload). Deload alerts
  ("your bench stalled 3 sessions, take a lighter week") are the most coach-like feature possible
  and derive purely from stored data.
- **Where:** `src/lib/planGeneration.ts` (carry per-muscle set counts forward across weeks) +
  new logic reading session/RIR history.
- **Caveat:** weeks of work, invisible until a user has trained a while. Genuinely phase 2.

### 10. Per-user RIR calibration
- **Why:** Replaces the static `beginnerScale = 0.5` with a learned, per-user effort bias. The
  real "it learns you" feature, no LLM in the load path.
- **Caveat:** cold-start / sparse-signal problem — you only observe true reps-to-failure when
  users go to failure, which good programming avoids. Converges slowly; manage expectations and
  consider occasional AMRAP/failure sets to feed it.

### 11. Apple Watch / Health Connect + optional HRV readiness
- **Why:** Hardware integration measurably extends retention. The real near-term draw is the
  wrist-haptic rest timer + one-tap set logging, NOT HRV (which is directionally useful at best;
  Garmin's own readiness score is unvalidated).
- **Caveat:** multi-week native integration. Only build once the core has proven it retains.
  Libraries: `@kayzmann/expo-healthkit` (iOS), `react-native-health-connect` (Android); both need
  a custom dev client (you already build via EAS).

---

## The one rule that orders all of this

The moat is the engine and the **proof** of the engine. The near-term job is not to add features —
it's to make the existing loop **fast** (rest timer, tap count), **visible** (effort trend), and
**in front of real users**, then monetize what they demonstrably come back for. Everything in
Phase 2 waits until the data earns it. Resist the rest.
