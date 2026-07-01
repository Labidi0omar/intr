# Intr — Play Store Listing & Data Safety (ready to paste)

> Draft prepared while account verification is pending. Verify every Data Safety
> answer against your actual code before submitting — Google rejects listings whose
> Data Safety form contradicts the privacy policy.

---

## 1. Store Listing

**App name** (max 30 chars)
```
Intr
```

**Short description** (max 80 chars)
```
A strength coach that tracks your lifts and tells you when to push or back off.
```

**Full description** (max 4000 chars)
```
Intr is a strength-training app with a built-in coach — one that watches how you actually train and tells you what to do next, instead of handing you a generic template you abandon by week two.

Tell Intr your schedule and experience once, and it builds a personalized weekly plan: the right split (full body, upper/lower, push-pull-legs, or a bro split) based on how many days you train. Every session is laid out for you — exercises, sets, reps, and rest — so you walk into the gym knowing exactly what to do.

YOUR COACH, BUILT IN

Intr's coach pays attention. After every session it reads what you actually did — your lifts, your effort, your trend — and gives you a short, personal read on where you stand. Not generic "great job!" spam; real observations like a PR you just hit, a lift that's climbing, or a week where you showed up tired and trained anyway. Over time it tells you plainly whether you're progressing, holding steady, or backing off — so you always know if it's time to push or pull back.

WHAT MAKES INTR DIFFERENT

Adapts to your week. Miss a few days? The coach notices and lets you pick up where you left off or skip ahead — no broken plan, no guilt.

Tracks what matters. Log your sets, weights, and reps-in-reserve. Intr watches your strength trend per lift and turns it into a clear training status.

Smart recovery. Built-in deload logic reads your recent training and offers a recovery week when you need one — and lets you skip it when you're flying. No overtraining, no second-guessing.

Stays honest about effort. Rate your energy before each session. Intr factors real fatigue into your training status instead of pretending every day is a max day.

Swap freely. Don't like an exercise or the machine's taken? Swap it — Intr keeps your volume intact and remembers the swap for future sessions.

Reflect and share. Keep a daily training journal, and turn any session into a clean shareable card for your story.

Works offline. Your plan lives on your device, so a bad signal at the gym never blocks your workout.

Intr is for people who are done program-hopping and want one app — and one coach — that quietly keeps them progressing. Train, log, recover, repeat.
```

**Category:** Health & Fitness
**Tags:** workout, strength training, gym, fitness tracker, weightlifting
**Contact email:** labidiomar04@gmail.com
**Privacy policy URL:** https://labidi0omar.github.io/intr/privacy-policy.html

---

## 2. Data Safety form answers

**Top-level questions**
- Does your app collect or share any required user data types? **Yes**
- Is all of the user data collected by your app encrypted in transit? **Yes** (HTTPS / Supabase)
- Do you provide a way for users to request that their data is deleted? **Yes**
  → Deletion URL: https://labidi0omar.github.io/intr/account-deletion.html

### Data types to declare

For each: Collected = Yes. Shared = No (third parties below are processors acting on
your behalf, not receiving data for their own use — confirm this matches your contracts).
Mark each as "Collected." Purposes are listed per item.

| Data type | Category | Collected | Purpose | Optional/Required |
|---|---|---|---|---|
| Email address | Personal info | Yes | Account management, authentication | Required |
| Name / username | Personal info | Yes | App functionality (personalization) | Required |
| Health & fitness info (workouts, plans, body weight, energy ratings) | Health and fitness | Yes | App functionality | Required |
| User-generated content (journal entries) | App activity / Other user content | Yes | App functionality | Optional |
| App interactions (analytics events) | App activity | Yes | Analytics | Required |
| Crash logs & diagnostics | App info & performance | Yes | Crash prevention / diagnostics | Required |

### NOT collected (do not check these)
- **Photos:** the photo you pick for a share card is used on-device only to build the
  image and is never uploaded to your servers → do NOT declare photos as collected.
  (Confirm this is still true in code before relying on it.)
- **Location, contacts, financial info, device IDs for ads:** none collected.
- No data is used for advertising or shared with data brokers.

### Third-party processors (for your own records / privacy policy, not all shown in the form)
- **Supabase** — database, auth, storage (your backend).
- **Sentry** — crash/diagnostics (the "crash logs & diagnostics" line above).
- **Anthropic** — receives workout context to generate coach recap text. If any
  user-identifiable data is sent, confirm it's covered in your privacy policy.

---

## 3. Pre-submit consistency check
- [ ] Every "Collected: Yes" row above also appears in the privacy policy.
- [ ] Deletion URL works and is pasted into both Data Safety and the listing.
- [ ] Photos are still on-device only (re-check ShareCard before declaring "not collected").
- [ ] Anthropic data flow described in privacy policy if any identifiable data leaves the app.
