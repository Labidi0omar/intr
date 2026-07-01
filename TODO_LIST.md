# Intr — To-Do List (Growth / Virality)

## Core principle: build a loop, not a screen
A share button doesn't go viral. A loop does:
**peak moment → auto-generated artifact the user is proud to post → recipient thinks "I want *that*" (not just "good for them") → one-tap path to try.**
If any link is weak, it dies. The recipient's reaction is the part most apps skip.

## What already exists (build on, don't rebuild)
- `src/components/ShareCard.tsx` — a share-card component is already scaffolded.
- `app.json` declares Instagram + Instagram-Stories query schemes → share-to-stories intent is already there; it needs the right *content* on the card.

## The three candidate share artifacts

### 1. PR card — frequency + dopamine
- Auto-card the instant a personal record is hit ("Squat — 100 kg, new best").
- Highest-frequency peak moment, easiest dopamine hit; the workhorse.
- **Limit:** converts lifters who already lift. Outsiders see "100 kg" and think "nice," not "I need this." Spreads *within* the tribe, doesn't recruit outside it.

### 2. Progress-recap card — conversion (recommended viral lead)
- End-of-block (every ~4 weeks) auto story: "12 weeks with Intr — Squat +25 kg, Bench +15 kg, 38 sessions."
- Shows an **outcome the app drove**, not just an event → makes a viewer curious ("that actually worked — what is this?").
- Aspirational to outsiders, recurs on a natural cadence, ties straight to the brand (real data, the coach got me here).

### 3. Coach-intelligence flex — most differentiated
- "My app told me to back off a week before my lifts dropped — and it was right."
- A screenshot no other app can produce; converts the exact audience that pays (serious lifters).
- Lower-frequency, niche, but the most defensible because it's un-copyable.

## Recommended play
- **Lead with the progress-recap** as the viral artifact (it recruits outsiders).
- **PR card** as the frequency driver (keeps existing users posting).
- Consider the **coach-intelligence flex** as the differentiated, un-copyable angle.

## Loop mechanics still needed
- Tasteful "Made with Intr" mark on every card (non-spammy).
- A **deep link / referral path** so a tap installs and drops the new user into the same flow. (Open question: does a referral/deep-link path exist yet?)

## Open decisions
- [ ] Which artifact to build first (recommended: progress-recap)
- [ ] Referral / deep-link path — design or confirm it exists
- [ ] Where the share CTA surfaces (post-PR, end-of-block recap, both)
