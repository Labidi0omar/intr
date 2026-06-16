// The MOUTH of the coach.
//
// phraseObservation(obs) maps a structured Observation to one short
// sentence. Selection from each per-type pool is DETERMINISTIC — index =
// stableHash(obs.factSig) % pool.length — so the same fact yields the same
// line every time, and across-fact variety lands by hash diffusion rather
// than per-call randomness. No Math.random, no Date.now, no AsyncStorage.
//
// TONE: terse, declarative, serious-lifter. No emoji, no exclamation
// cheerleading; praise is earned and stated flat ("Bench up three sessions:
// 80, 82.5, 85." not "Great job!"). If a line ever reads as a hype-bot, the
// pool is wrong — replace the entry, don't add an exclamation.
//
// STAGE 3 will replace or wrap this function with an AI phraser. The
// signature is `(obs: Observation) => string` — same in, same out — so the
// swap is a one-line change at the call site. The Observation shape is the
// contract; do not let the BRAIN start carrying prose, and do not let the
// MOUTH start inventing new facts.

import type { CoachObservation } from './coachObservations';

// ── Deterministic pool indexer ─────────────────────────────────────────

/** djb2 — small, fast, no dependency. Returns a non-negative 32-bit int.
 *  Stability matters: the same factSig must always pick the same pool
 *  entry, including across builds. */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // ((h * 33) ^ c) but in 32-bit space
    h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function pick<T>(pool: readonly T[], factSig: string): T {
  // Pool size > 0 is enforced at definition time below; the modulo is safe.
  return pool[stableHash(factSig) % pool.length];
}

// ── Number formatting (for prose) ──────────────────────────────────────

/** Up-to-one-decimal kg with the trailing ".0" trimmed. 82.5 → "82.5",
 *  80 → "80", 80.25 → "80.3". Matches the rest of the app's kg rendering. */
function kg(n: number): string {
  const r = Math.round(n * 10) / 10;
  const s = r.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Percent rendered as an integer, no trailing %. The phrasing supplies the
 *  unit. 0.6 → "60", 0.275 → "28". */
function pctInt(p: number): string {
  return String(Math.round(p * 100));
}

// ── Phrase pools ───────────────────────────────────────────────────────
// Three to five entries per slot. Add entries freely — adding does not
// change which line an EXISTING factSig picks (the modulo only re-spreads
// at the boundary, not retroactively). Removing or reordering DOES shift
// picks; do not reorder once a pool has shipped to users without a deload
// in voice continuity expectations.

const LIFT_UP_POOL: readonly ((lift: string, from: number, to: number, span: number) => string)[] = [
  (lift, from, to, span) => `${lift} is moving — ${kg(from)} to ${kg(to)} kg over your last ${span} sessions.`,
  (lift, from, to, span) => `${lift}'s climbing. Up to ${kg(to)} kg now from ${kg(from)}, ${span} sessions running.`,
  (lift, from, to, span) => `Good trend on ${lift}: ${kg(from)} to ${kg(to)} kg across ${span} sessions.`,
  (lift, from, to) => `${lift} keeps going up — ${kg(to)} kg now, started at ${kg(from)}.`,
];

// New-high variant of the up arc — the latest top is the highest on record in
// the window. References the streak (span sessions) AND the new best, so the
// line connects the run to the milestone instead of "bench up 5 kg".
const LIFT_UP_HIGH_POOL: readonly ((lift: string, from: number, to: number, span: number) => string)[] = [
  (lift, _from, to, span) => `${lift} just hit a new high — ${kg(to)} kg, ${span} sessions of steady gains.`,
  (lift, from, to, span) => `New top on ${lift}: ${kg(to)} kg. That's ${span} sessions climbing straight, ${kg(from)} to ${kg(to)}.`,
  (lift, _from, to, span) => `${lift} has climbed ${span} sessions straight to a new best — ${kg(to)} kg.`,
];

const LIFT_STALL_POOL: readonly ((lift: string, weight: number, span: number) => string)[] = [
  (lift, weight, span) => `${lift} has been stuck at ${kg(weight)} kg for ${span} sessions. Next time, push for one more rep or nudge the weight up.`,
  (lift, weight, span) => `${lift}'s stalled — same ${kg(weight)} kg ${span} sessions running. Break it: one more rep, or a lighter week and rebuild.`,
  (lift, weight, span) => `No movement on ${lift} in ${span} sessions, still ${kg(weight)} kg. Force the issue next time.`,
];

const LIFT_COMEBACK_POOL: readonly ((lift: string, days: number) => string)[] = [
  (lift, days) => `First time back on ${lift} in ${days} days. Start a touch under your old top set and build up.`,
  (lift, days) => `${lift}'s been on ice for ${days} days. Ease in — don't chase your old number today.`,
  (lift, days) => `${days} days since your last ${lift}. Find the groove before you load it heavy.`,
];

const SESSION_PR_POOL: readonly ((lift: string, newKg: number, prevKg: number) => string)[] = [
  (lift, newKg, prevKg) => `New best on ${lift} — ${kg(newKg)} kg, past your old ${kg(prevKg)}.`,
  (lift, newKg, prevKg) => `${lift} PR: ${kg(newKg)} kg. Beat your previous ${kg(prevKg)}.`,
  (lift, newKg, prevKg) => `That's a ${lift} record — ${kg(newKg)} kg, up from ${kg(prevKg)}.`,
];

const CONSISTENCY_POOL: readonly ((count: number, denom: number) => string)[] = [
  (count, denom) => `${count} of the last ${denom} days in the gym. That consistency is what moves the needle.`,
  (count, denom) => `${count} sessions in ${denom} days. This is the part most people skip — keep it up.`,
  (count, denom) => `${count} of ${denom} days trained. Showing up is the whole game.`,
];

// "Block" / "deload" are coach-speak. We use plain language: a 4-week
// cycle of three building weeks plus one lighter recovery week. The third
// week is the last hard push; the fourth is intentionally light so the
// body absorbs the work.
const BLOCK_WEEK3_POOL: readonly string[] = [
  `Third hard week — give it everything, then you've earned a lighter one.`,
  `You're at the top of the build. One more heavy week, then we back off to recover.`,
  `Last hard week of this stretch. Push now; the easy week is coming.`,
];

const BLOCK_WEEK4_POOL: readonly string[] = [
  `Easy week. Go lighter on purpose — this is when the last three weeks actually pay off.`,
  `Recovery week. Keep it light and let your body catch up; you come back stronger.`,
  `This one's meant to be easy. Light loads, clean reps, no grinding.`,
];

// Effort zone — plain language. The idea: hard sets should be close to
// failure (where strength + size are built); if they're consistently easy,
// the loads are too light to drive progress. We avoid "RIR" (reps in
// reserve) entirely — most users don't know the term and the number alone
// communicates the same thing.
const EFFORT_HIGH_POOL: readonly ((pct: number) => string)[] = [
  (pct) => `Most of your hard sets are ending close to failure (${pctInt(pct)}%). That's exactly where muscle gets built — keep it there.`,
  (pct) => `You're taking ${pctInt(pct)}% of your top sets near the limit. That's honest effort — don't ease up.`,
  () => `Your hard sets are landing right where they should — pushed close to the limit. Stay there.`,
];

const EFFORT_LOW_POOL: readonly ((pct: number) => string)[] = [
  (pct) => `Your hard sets are stopping too early — only ${pctInt(pct)}% get near the limit. Add weight or grind out a couple more reps.`,
  () => `You're leaving too much in the tank. Take your top sets closer to failure next time.`,
  () => `The loads are playing it safe. Add a bit of weight and make those sets count.`,
];

// "Dialed in" — the autoregulator is visibly working for the user. Use
// the real hits/total numbers so the line reads as evidence, not flattery.
// No exclamation, no hype; the data IS the praise.
const DIALED_IN_POOL: readonly ((hits: number, total: number) => string)[] = [
  (hits, total) => `${hits} of your last ${total} sets hit the 1–2 RIR sweet spot — the engine's tuned to you.`,
  (hits, total) => `${hits} out of ${total} top sets in the 1–2 RIR target zone. The plan is reading you right.`,
  (hits, total) => `${hits} of ${total} recent sets landed in the productive band. Your loads are dialed in.`,
];

const COMEBACK_POOL: readonly ((gapDays: number) => string)[] = [
  (gapDays) => `Welcome back — looks like you missed about ${gapDays} sessions. Just getting in today counts; don't chase old numbers.`,
  (gapDays) => `Been away for around ${gapDays} sessions. Drop today's weights about 10% and build back up.`,
  (gapDays) => `Back after roughly ${gapDays} missed sessions. Treat today as easing in, not proving anything.`,
];

const FALLBACK_POOL: readonly ((workoutType: string, n: number) => string)[] = [
  (workoutType, n) => `Today's a ${workoutType} day — ${n === 1 ? '1 exercise' : `${n} exercises`} on the board.`,
];

// Rest-day baseline — the counterpart of FALLBACK_POOL for a day with no
// planned training. Same TONE: plain, terse, no emoji, no exclamation, no
// hype. Permission to rest, with the door left open to move if they want —
// it complements the "Active recovery" CTA, it doesn't push it.
const REST_DAY_POOL: readonly string[] = [
  `Rest day — take it. If you feel like moving, you still can.`,
  `Scheduled rest today. Recovery is where the work sticks — let it.`,
  `No session on the board today. Rest up; light movement's fine if you want it.`,
];

// ── Composite (synthesis) pools ─────────────────────────────────────────
// These connect signals the single-fact pools would say separately. Same
// TONE: terse, no emoji, no exclamation, no invented physiology ("nervous
// system" etc.). Only the lift name (real data) is interpolated — the
// judgment is qualitative, so there are no numbers to get wrong.
const PUSHING_HARD_POOL: readonly ((lift: string) => string)[] = [
  (lift) => `${lift} is still climbing, but you're running hot — bank the win and protect recovery this week.`,
  (lift) => `Real progress on ${lift}, and the fatigue's stacking up with it. Take the gain, ease the throttle this week.`,
  (lift) => `You're pushing hard — ${lift}'s up but recovery's slipping. Hold what you've built and pull the volume back a touch.`,
];

const GRINDING_POOL: readonly ((lift: string) => string)[] = [
  (lift) => `${lift}'s grinding and your energy's been low — that's a recovery week asking to happen. Lighten up and reset.`,
  (lift) => `You're slogging on ${lift} with the tank low. No shame in a lighter week — that's usually where the stall breaks.`,
  (lift) => `${lift} has stalled and you're showing up tired. Pull back, sleep, come back to it fresh.`,
];

const BACK_ON_TRACK_POOL: readonly ((lift: string) => string)[] = [
  (lift) => `Back in the groove — ${lift}'s moving again after the break. Keep the momentum, don't force it.`,
  (lift) => `${lift}'s climbing again since you got back. The hard part's done; just keep showing up.`,
  (lift) => `You returned and ${lift} is already trending up. That's the comeback working — stay the course.`,
];

// Plan rationale — split-specific because the framing is different per
// split. Each sub-pool obeys the same TONE constraints (no emoji, no
// exclamation, terse). Variants reference only `trainingDays` and the
// vocabulary allowed by allowedNumbersFor (notably the constant 2 for
// "twice a week" / "2x").
const RATIONALE_FULL_BODY_POOL: readonly string[] = [
  `You train once a week, so I built a full-body plan — every session hits everything.`,
  `One day a week means full-body each time. Nothing gets left out.`,
  `With a single weekly session, the smart move is full-body. That's what you've got.`,
];

const RATIONALE_UPPER_LOWER_POOL: readonly string[] = [
  `Two days a week, so I split it upper/lower — each muscle gets worked twice.`,
  `Upper one day, lower the next. Over 2 sessions everything gets hit twice.`,
  `Your 2 days run as an upper/lower split, so nothing's trained just once a week.`,
];

const RATIONALE_PPL_POOL: readonly ((trainingDays: number) => string)[] = [
  (td) => `${td} days a week lets us run push/pull/legs — more focused volume per muscle.`,
  (td) => `With ${td} sessions, you're on push/pull/legs. Each group gets its own day.`,
  (td) => `${td} days means push/pull/legs — hard work, then real recovery between sessions.`,
];

const RATIONALE_BRO_SPLIT_POOL: readonly ((trainingDays: number) => string)[] = [
  (td) => `${td} days a week, so each muscle gets its own day — deep, focused work.`,
  (td) => `A body-part split fits your ${td} days. One muscle group per session, done properly.`,
  (td) => `With ${td} sessions, every muscle gets a dedicated day. That's where the volume pays off.`,
];

// Calibration — pure prose pool. No `trainingDays` reference; only the
// constants 2 and 14 are allowed (and most variants don't use either).
const CALIBRATION_POOL: readonly string[] = [
  `First couple weeks, I'm learning your real strength — every set you log sharpens the plan.`,
  `Early days. Log honestly and I'll have your loads dialed in fast.`,
  `Still getting your numbers. The next 2 weeks set your real baseline.`,
  `We're just getting started. Show up and I'll tune the weights to you.`,
  `Give me a couple honest weeks and the coaching gets a lot more specific.`,
];

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Observation → coach line. Pure, deterministic, terse.
 *
 * Same factSig → same line, always. Adding a new entry to a pool does NOT
 * retroactively shift existing factSigs (it only changes what NEW factSigs
 * would map to at the boundary). Reordering or removing entries DOES shift
 * picks — treat the pool order as a stable contract once shipped.
 *
 * STAGE 3: wrap or replace this function with an AI phraser. The signature
 * is the contract: `(Observation) => string`. The BRAIN never changes.
 */
export function phraseObservation(obs: CoachObservation): string {
  switch (obs.type) {
    case 'lift_progression':
      if (obs.subtype === 'up') {
        // A new all-time high gets the milestone-aware pool; an ordinary
        // climb gets the steady-arc pool. Both reference the run (span).
        const upPool = obs.isAllTimeHigh ? LIFT_UP_HIGH_POOL : LIFT_UP_POOL;
        return pick(upPool, obs.factSig)(obs.lift, obs.from, obs.to, obs.span);
      }
      if (obs.subtype === 'stall') {
        return pick(LIFT_STALL_POOL, obs.factSig)(obs.lift, obs.weight, obs.span);
      }
      return pick(LIFT_COMEBACK_POOL, obs.factSig)(obs.lift, obs.days);
    case 'session_pr':
      return pick(SESSION_PR_POOL, obs.factSig)(obs.lift, obs.newKg, obs.prevKg);
    case 'consistency': {
      const denom = obs.metric === 'days14' ? 14 : 28;
      return pick(CONSISTENCY_POOL, obs.factSig)(obs.count, denom);
    }
    case 'block_position':
      return pick(obs.blockWeek === 3 ? BLOCK_WEEK3_POOL : BLOCK_WEEK4_POOL, obs.factSig);
    case 'effort_zone':
      return obs.band === 'high'
        ? pick(EFFORT_HIGH_POOL, obs.factSig)(obs.pct)
        : pick(EFFORT_LOW_POOL, obs.factSig)(obs.pct);
    case 'dialed_in':
      return pick(DIALED_IN_POOL, obs.factSig)(obs.hits, obs.total);
    case 'comeback':
      return pick(COMEBACK_POOL, obs.factSig)(obs.gapDays);
    case 'briefing_fallback':
      return pick(FALLBACK_POOL, obs.factSig)(obs.workoutType, obs.exerciseCount);
    case 'rest_day':
      return pick(REST_DAY_POOL, obs.factSig);
    case 'pushing_hard':
      return pick(PUSHING_HARD_POOL, obs.factSig)(obs.lift);
    case 'grinding':
      return pick(GRINDING_POOL, obs.factSig)(obs.lift);
    case 'back_on_track':
      return pick(BACK_ON_TRACK_POOL, obs.factSig)(obs.lift);
    case 'plan_rationale':
      switch (obs.split) {
        case 'full_body':
          return pick(RATIONALE_FULL_BODY_POOL, obs.factSig);
        case 'upper_lower':
          return pick(RATIONALE_UPPER_LOWER_POOL, obs.factSig);
        case 'ppl':
          return pick(RATIONALE_PPL_POOL, obs.factSig)(obs.trainingDays);
        case 'bro_split':
          return pick(RATIONALE_BRO_SPLIT_POOL, obs.factSig)(obs.trainingDays);
        default:
          // Unknown split label — degrade to a neutral line rather than
          // throwing. Should never fire in practice (the builder gates on
          // a non-null split from profiles.preferred_split).
          return `${obs.trainingDays} training days a week — the plan is built around that cadence.`;
      }
    case 'calibration':
      return pick(CALIBRATION_POOL, obs.factSig);
  }
}

/** dedupKey shape used by appendCoachMessageOnce. Same factSig = permanent
 *  no-op; once the underlying number advances (and factSig changes), the
 *  line speaks again. Keeping this as a tiny helper means call sites don't
 *  invent ad-hoc key shapes. */
export function dedupKeyFor(obs: CoachObservation): string {
  return `obs:${obs.id}:${obs.factSig}`;
}

/** Parse a factSig back out of a stored dedupKey (or return null). The
 *  selector's recentFactSigs set is built from the trailing N dedupKeys
 *  pulled from the message store. Robust to extra colons in id/factSig —
 *  we split on the FIRST two segments. */
export function factSigFromDedupKey(dedupKey: string | undefined | null): string | null {
  if (!dedupKey) return null;
  if (!dedupKey.startsWith('obs:')) return null;
  // Format: obs:<id>:<factSig>. The id can itself contain a colon (e.g.
  // "lift_progression:Bench"), so the factSig is everything after the
  // LAST colon, not the third segment.
  const lastColon = dedupKey.lastIndexOf(':');
  if (lastColon <= 3) return null;
  return dedupKey.slice(lastColon + 1);
}
