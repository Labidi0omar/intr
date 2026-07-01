# Intr — Elevation Review (two-persona exercise)

Two voices. **Maya** is the product strategist: she researches, proposes, and builds the case.
**Kofi** is the skeptic: he reviews Maya's proposals, kills the weak ones, and reranks by leverage.
Everything is grounded in the actual codebase and the market research already done.

---

## Context both personas share (the ground truth)

- **What Intr is:** a React Native / Expo + Supabase workout app whose real differentiator is
  RIR-based autoregulation — capture felt effort, prescribe next load deterministically, let an
  LLM only adjust within ±1 plate on low-energy days. The plan generator is a deterministic rule
  engine, not AI.
- **What's built:** RIR capture, prescription engine (client + server, beginner-scaled,
  parity-tested), AI replanner with safety clamp, energy-based volume scaling (now both
  directions), session ordering, measurement events + efficacy view. 57 passing tests.
- **What's NOT built:** the entire money path. RevenueCat keys are empty, no paywall screen
  exists, `useEntitlement()` always returns false, the replanner's tier is hardcoded `free`.
- **Market reality:** Strong ($30/yr), Hevy (free tier + social, ~$24/yr), Fitbod ($96/yr,
  adaptive but ignores subjective/recovery state). Reddit's consistent complaints: too many taps
  to log, feature bloat, paywalling core features, no data export. Fitness apps retain ~3% at
  day 30; churn ~9.2%/mo; trial-to-paid for well-optimized fitness apps hits 30–50% when trial
  length matches time-to-value.

---

# PART 1 — MAYA'S PROPOSALS

## A. Positioning (everything flows from this)

Intr is not "another tracker." Trackers are a saturated, race-to-the-bottom-on-price category
owned by Strong and Hevy. Intr is **"the lifting coach that adapts to how you actually feel —
backed by the science, usable by someone who's never heard the word autoregulation."** Fitbod is
the only real competitor on adaptiveness and it explicitly ignores subjective readiness — that's
the seam. One sentence for the store: *"Tell it how hard the set felt. It handles the rest."*

## B. The money path (highest urgency — nothing works without it)

1. **Freemium, not hard paywall.** Intr is new and unproven; trust must be earned first. Free
   tier: full logging, manual plans, basic history. Paid ("Intr Pro"): the autoregulation engine
   (prescriptions, the AI replanner beyond ~3/month), advanced progress analytics, deload alerts.
2. **Onboarding-integrated paywall with a 7-day trial**, shown *after* the first generated plan
   so the user has seen value, personalized to the goal they just entered ("Your hypertrophy plan
   adapts every session with Pro"). Trial length ≈ time-to-first-real-prescription.
3. **Annual-default pricing** around $39.99/yr / $7.99/mo — above Hevy/Strong because the pitch is
   coaching, not logging, but below Fitbod.
4. Wire RevenueCat properly, replace the hardcoded `tier='free'` in `replan-today` with a real
   entitlement check via an RC webhook → `subscriptions` table the edge function reads.

## C. Retention mechanics (the real enemy — 3% day-30)

1. **Home-screen widget** showing today's session + streak. Widgets are repeatedly cited as a
   top re-engagement lever; cheap to build, persistent reminder.
2. **Apple Watch / Health Connect companion** — log sets and rest timer from the wrist; pull HRV
   + sleep as *optional* readiness inputs. Hardware integration measurably extends retention by
   anchoring to a device users already wear.
3. **"The coach was right" moment.** Surface the efficacy data back to the user: "You've hit your
   target effort zone 9 of your last 11 sessions." Turns the invisible engine into a visible,
   trust-building hook — and it's the thing no competitor can show.
4. **Smart deload alerts.** "Your bench has stalled 3 sessions and energy's been low — take a
   lighter week." The single most coach-like feature, pure derivation from stored data.
5. **Rest-day / streak protection** so a missed day doesn't nuke the streak and cause rage-quit.

## D. Core-loop UX (Reddit's #1 complaint: too many taps)

1. **Sub-3-second set logging.** Pre-fill weight (done via prescription), one-tap "same as
   prescribed," RIR as one tap — audit every interaction for tap count.
2. **Rest timer** with auto-start after a logged set, notification when it ends. Table stakes;
   Intr doesn't have one.
3. **In-workout reorder / superset support** — drag to reorder, group exercises. Currently the
   order is fixed.
4. **Plate calculator** on the weight input ("102.5kg = 20 + 20 + 1.25 per side").
5. **Data export (CSV).** Reddit explicitly distrusts apps that trap data. Cheap goodwill, kills
   a common objection in reviews.

## E. The engine, deepened (defend the moat)

1. **Per-user RIR calibration** replacing the static `beginnerScale=0.5` — learn each user's
   personal effort bias over time. "It learns you," no LLM needed in the load path.
2. **Volume landmarks (MEV→MAV→MRV)** so the plan is a living mesocycle that adds volume weekly
   and auto-deloads, not a weekly reshuffle. This is the structural reason users stay months.
3. **Make the energy-5 target picker classifier-based, not positional** (already flagged) so the
   "add sets to compounds" guarantee is intrinsic.

## F. Polish / trust

1. Fix the `fontVariantNumeric` baseline (3 style blocks) — it's a real RN warning.
2. Reconcile the docs (Flux/intr/Intr drift; phantom `generate-plan` function).
3. Onboarding that lets the user complete a first workout *before* full profile setup (show value
   before commitment — the single most-cited day-1 retention tactic).

---

# PART 2 — KOFI'S REVIEW

> Maya's list is good but it's a wish-list, not a plan. Half of it is "things good fitness apps
> have," which is exactly the bloat trap the research warns about. Let me cut.

**The positioning is right and it's the only thing here that isn't optional.** No notes. Everything
below must serve it or die.

**The money path is correctly #1, but Maya buried the real risk.** It's not "wire RevenueCat" —
that's an afternoon. The risk is **you have no data that anyone wants the paid feature.** Building
the paywall is worthless if the autoregulation engine doesn't actually retain. So the honest
sequence is: ship the engine free to a small cohort, watch the efficacy + retention data, and
*only* build the paywall once you see people coming back for the prescriptions. Pricing at $39.99
is a guess dressed as a number — you have zero willingness-to-pay signal. Don't anchor on it.

**Retention features — Maya proposed five; three are bloat at this stage.**
- *Widget* — yes, cheap and high-leverage. Keep.
- *"Coach was right" moment* — **this is the single best idea on the entire list** and Maya
  under-weighted it by burying it third. It's the only retention hook that is *unique to Intr*,
  directly proves the value prop, and runs on data you already collect. It should be near the top.
  Caveat: it depends on the efficacy metric, which is selection-biased — so show the user their own
  raw trend ("you hit target zone 9/11"), NOT a causal "the coach made you better" claim you can't
  support.
- *Deload alerts* — yes, on-thesis and coach-like. Keep, but it needs the volume-landmark work to
  be meaningful, so it's downstream.
- *Apple Watch / HRV* — **no, not now.** This is a multi-week native integration that the research
  itself says is directionally useful at best (Garmin's own readiness score is unvalidated). It's a
  classic "build the impressive thing before validating the core" trap. Park it.
- *Streak protection* — minor, do it when you do streaks, not a headline.

**Core-loop UX — Maya is right that this is underweighted, and the research backs her.** "Too many
taps" is the #1 documented complaint and Intr's logging flow has an interrupting weight overlay
*per exercise*. But she listed five items; only two are urgent:
- *Rest timer* — **table stakes, and its absence is embarrassing for a serious lifting app.** This
  is more urgent than half the engine work. A lifter rests 90s between sets; an app that doesn't
  time that isn't a lifting app. Do it now.
- *Sub-3s logging audit* — yes, ongoing discipline, not a feature.
- *Superset/reorder, plate calc, CSV export* — real but second-wave. CSV export is the cheapest
  goodwill/anti-objection item; do it before launch reviews start. Supersets can wait.

**The engine deepening — Maya's instincts are good but the priority is inverted.**
- *Volume landmarks (MEV/MAV/MRV)* — this is the **structural moat**, the reason a user is still
  here in month 3. But it's also weeks of work and it's invisible until the user has trained for a
  while. It's a "phase 2" bet, not a launch feature. Don't let it block getting the current engine
  in front of users.
- *Per-user RIR calibration* — great "it learns you" story, but Maya ignored the cold-start
  problem I'd flag: you only observe true reps-to-failure when users go to failure, which a good
  hypertrophy program avoids by design. So calibration data is sparse and converges slowly. Build
  it, but don't promise fast personalization.
- *Energy-5 classifier fix* — trivial, do it in the next cleanup batch, not a roadmap item.

**Polish — Maya's three are correct and she should stop apologizing for listing them.** The doc
drift is a real liability (you'll plan against a phantom function), the `fontVariantNumeric` warning
is one find-and-replace, and "first workout before full signup" is the single highest-ROI
onboarding change in the research. That last one is mis-filed under "polish" — it's a retention
lever and belongs up top.

---

# PART 3 — THE RECONCILED LIST (Kofi's final ranking)

**Do now (blocks launch or proves the core):**
1. **Rest timer** — table stakes, absence is disqualifying for a lifting app.
2. **"Coach was right" / personal effort-trend surface** — the unique, on-thesis retention hook;
   show raw trend, not causal claims.
3. **First-workout-before-full-signup onboarding** — highest-ROI day-1 retention change.
4. **Ship the engine free to a small cohort and watch efficacy + retention** before building the
   paywall. Data first, pricing later.
5. **Home-screen widget** — cheap, persistent re-engagement.

**Do before public launch (kills objections / closes gaps):**
6. CSV export (anti-objection, cheap goodwill).
7. Money path: RevenueCat + real entitlement check + onboarding-integrated trial paywall —
   *built once #4 shows people return.*
8. Doc reconciliation + `fontVariantNumeric` fix + energy-5 classifier fix (cleanup batch).

**Phase 2 (the durable moat, after launch validates the core):**
9. Volume landmarks → living mesocycle + meaningful deload alerts.
10. Per-user RIR calibration (slow-converging, manage expectations).
11. Apple Watch / Health Connect + optional HRV readiness — only if the core has proven it retains.

**The one-line verdict:** the moat is the engine and the proof-of-engine ("coach was right"). The
near-term job is not to add features — it's to make the existing loop fast (rest timer, taps),
visible (effort trend), and in front of real users, *then* monetize what they demonstrably return
for. Resist everything else until the data earns it.
