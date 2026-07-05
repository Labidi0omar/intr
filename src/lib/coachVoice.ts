// The MOUTH of the coach.
//
// phraseObservation(obs) maps a structured Observation to one short
// sentence. Selection from each per-type pool is DETERMINISTIC — index =
// stableHash(obs.factSig) % pool.length — so the same fact yields the same
// line every time, and across-fact variety lands by hash diffusion rather
// than per-call randomness. No Math.random, no Date.now, no AsyncStorage.
//
// TONE: a friend who trains seriously and gives a shit. Dry humor, honest,
// never cheers, never sounds like a status report. Praise is earned and
// stated flat ("Bench up three sessions: 80, 82.5, 85." not "Great job!").
// Occasional rhetorical questions are fine — they make the coach sound
// like a person, not a state machine. Warmth lives in noticing the right
// thing, not in the adjectives. If a line reads as a hype-bot or a
// corporate status update, the pool is wrong — replace the entry.
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
// HERO INVARIANTS (the dashboard signature surfaces ONE line):
//   1. ≤ 130 chars per line, even at the largest realistic interpolation.
//   2. Every line carries a forward beat — state of play AND what to do
//      today. The beat can be an imperative ("get one more rep"), a
//      rhetorical question ("ready to chase it?"), or an implicit
//      directive ("the break comes from reps, not weight"). Pure
//      description ("Bench hit a new high") with no forward-looking cue
//      is rejected by the test.
//   3. No emoji, no "deload"/"mesocycle"/insider jargon. Exclamation
//      marks are allowed on genuine milestones (PRs, new highs, streaks)
//      but never on ordinary reads — cheerleading erodes trust.
//
// Add entries freely — adding does not change which line an EXISTING
// factSig picks (the modulo only re-spreads at the boundary, not
// retroactively). Removing or reordering DOES shift picks; do not reorder
// once a pool has shipped to users without a continuity break.

const LIFT_UP_POOL: readonly ((lift: string, from: number, to: number, span: number) => string)[] = [
  (lift, _from, to) => `${lift} up to ${kg(to)} kg. Build the rep before the weight today — the arc is doing the work.`,
  (lift, _from, to) => `${lift} keeps moving — ${kg(to)} kg now. Don't rush the next jump; let this one settle.`,
  (lift, _from, to) => `${lift}'s on a run at ${kg(to)} kg. Same load today, sharper reps. The number follows the form.`,
  (lift, _from, to) => `${lift} climbing to ${kg(to)} kg. Today's job is clean reps, not a test.`,
  (lift, _from, to) => `${kg(to)} kg on ${lift} — that's the new working weight. Hit it clean, don't chase the next one yet.`,
  (lift, _from, to) => `${lift} keeps ticking up: ${kg(to)} kg now. Show up, make the reps honest, let the trend run.`,
  (lift, _from, to) => `${lift} at ${kg(to)} kg and still climbing. The form has to carry the weight — don't let it slip today.`,
  (lift, _from, to) => `Another step on ${lift} — ${kg(to)} kg. The rep quality is what keeps this going. Protect it today.`,
];

// New-high variant — milestone read with a directive that protects the gain.
// Each entry references the latest top weight AND a /new (high|top|best)/
// phrase (the test pins this). Exclamation is allowed on a genuine new high.
const LIFT_UP_HIGH_POOL: readonly ((lift: string, from: number, to: number, span: number) => string)[] = [
  (lift, _from, to) => `${lift} hit a new top — ${kg(to)} kg! Cement the form today; don't chase another this week.`,
  (lift, _from, to) => `New high on ${lift}: ${kg(to)} kg. Today's job is clean reps at last week's load — bank the win.`,
  (lift, _from, to) => `${lift} at ${kg(to)} kg, a new best. Lock it in today, then push next time. Don't rush it.`,
  (lift, _from, to) => `${lift} just hit ${kg(to)} kg — a new high. Hold the load today, make every rep count.`,
  (lift, _from, to) => `New top on ${lift}: ${kg(to)} kg. The gain sticks when you don't chase another one today.`,
  (lift, _from, to) => `${lift} broke through to a new top — ${kg(to)} kg. Cement it with clean reps today.`,
  (lift, _from, to) => `${kg(to)} kg on ${lift} — your new best. The smart move today is hold the load and own the reps.`,
  (lift, _from, to) => `New high: ${lift} at ${kg(to)} kg. Don't add weight today — let the body absorb it first.`,
];

const LIFT_STALL_POOL: readonly ((lift: string, weight: number, span: number) => string)[] = [
  (lift, weight, span) => `${lift} stuck at ${kg(weight)} kg for ${span} sessions. Don't add weight — get one more rep today.`,
  (lift, weight, span) => `${kg(weight)} kg has been the wall on ${lift} for ${span} sessions. That's a checkpoint, not a plateau. Chase the rep.`,
  (lift, weight, span) => `${lift} hasn't moved in ${span} sessions, still ${kg(weight)} kg. The break comes from reps, not weight. Push for one more.`,
  (lift, weight, span) => `${lift} stalled at ${kg(weight)} kg, ${span} sessions running. Hold the load, hunt the extra rep. It'll break.`,
  (lift, weight, span) => `${span} sessions at ${kg(weight)} kg on ${lift}. Weight isn't the lever right now — rep quality is. Make today's set count.`,
  (lift, weight, span) => `${lift} parked at ${kg(weight)} kg for ${span} sessions. That's not failure — it's the body learning. Force one extra rep today.`,
  (lift, weight, span) => `Still at ${kg(weight)} kg on ${lift} after ${span} sessions. Don't chase the number — chase a cleaner set today. The weight follows.`,
  (lift, weight, span) => `${lift}'s been sitting at ${kg(weight)} kg. The stall breaks when you own the rep, not when you add the plate. Get one more.`,
];

const LIFT_COMEBACK_POOL: readonly ((lift: string, days: number) => string)[] = [
  (lift, days) => `First ${lift} in ${days} days. Start a touch under your old top — the groove comes back before the weight does.`,
  (lift, days) => `${lift}'s been on ice ${days} days. Ease back in; don't chase the old number. Find the rhythm first.`,
  (lift, days) => `${days} days off ${lift}. The form is still in there — let it show up before you load it up.`,
  (lift, days) => `Back on ${lift} after ${days} days. The smart move: drop 10%, own every rep, trust the comeback.`,
  (lift, days) => `${lift} again after ${days} days off. The numbers will be there next week — today is about showing up.`,
  (lift, days) => `${days} days since you touched ${lift}. Don't prove anything today — just find the groove and load it honest.`,
  (lift, days) => `Welcome back to ${lift} — ${days} days off. The strength returns faster than it left. Start light, move clean.`,
  (lift, days) => `First ${lift} in a while (${days} days). The body remembers; let it. Don't force the old top set today.`,
];

const SESSION_PR_POOL: readonly ((lift: string, newKg: number, prevKg: number) => string)[] = [
  (lift, newKg, prevKg) => `${lift} PR — ${kg(newKg)} kg, past ${kg(prevKg)}! Take the win; don't chase another one today.`,
  (lift, newKg, prevKg) => `New best on ${lift}: ${kg(newKg)} kg (was ${kg(prevKg)}). Bank it — the next jump waits for clean reps.`,
  (lift, newKg, prevKg) => `${lift} record at ${kg(newKg)} kg, beating ${kg(prevKg)}. Hold it today; let the body catch the number.`,
  (lift, newKg, prevKg) => `${lift} PR! ${kg(newKg)} kg, up from ${kg(prevKg)}. The smart move: same load next time, own the reps.`,
  (lift, newKg, prevKg) => `${kg(newKg)} kg on ${lift} — a new best, past ${kg(prevKg)}. Don't push for another today; cement this one.`,
  (lift, newKg, prevKg) => `PR on ${lift}: ${kg(newKg)} kg (was ${kg(prevKg)}). That's the work paying off. Hold the load, sharpen the rep.`,
  (lift, newKg, prevKg) => `${lift} just hit ${kg(newKg)} kg — new record, past ${kg(prevKg)}. Take it. The next jump isn't today.`,
  (lift, newKg, prevKg) => `New top on ${lift}: ${kg(newKg)} kg, beating ${kg(prevKg)}. Real progress. Now lock it in with a clean session.`,
];

const CONSISTENCY_POOL: readonly ((count: number, denom: number) => string)[] = [
  (count, denom) => `${count} of last ${denom} days in. That's the work — keep showing up.`,
  (count, denom) => `${count} of ${denom} days trained. Don't miss today — the trend is the whole game.`,
  (count, denom) => `${count} sessions in ${denom} days. Cadence is the lever. Pull it again today.`,
  (count, denom) => `${count}/${denom} days. That's not luck, that's habit. Show up again — it compounds.`,
  (count, denom) => `${count} of ${denom}. The streak doesn't care about motivation; it cares about today. Show up.`,
  (count, denom) => `You've trained ${count} of the last ${denom} days. The body is paying attention. Don't break the pattern today.`,
  (count, denom) => `${count} sessions, ${denom} days. That's how it's done — one more today and the month looks different.`,
  (count, denom) => `Consistency at ${count}/${denom} days. The numbers move when the habit does. Keep it going today.`,
];

// Mesocycle framing — plain language. The 4-week cycle: three building
// weeks, one lighter recovery week. Week 3 is the last hard push; week 4
// is intentionally light. Avoid "deload" / "mesocycle" / "block week"
// (pinned by tests; users don't know the jargon).
const BLOCK_WEEK3_POOL: readonly string[] = [
  `Week 3 — last hard build before you back off. Make it count today.`,
  `Top of the build, third hard week. Push now; the easy one's coming.`,
  `Last heavy week in this run. Empty the tank; recovery's next.`,
  `Week 3 of 4 — the peak of the build. This is where the work lands. Go hard today.`,
  `Third week in. The body's carrying real fatigue — push through today, the back-off is earned.`,
  `Final hard week before the reset. Don't hold back today; this is the session that counts.`,
  `Week 3. The heaviest of the build. Show up full — recovery week gives you the runway to empty it.`,
  `Last push before the easy week. Today's session is the one you'll feel next month. Make it honest.`,
];

const BLOCK_WEEK4_POOL: readonly string[] = [
  `Recovery week. Go lighter on purpose — that's where the work sticks.`,
  `Easy week by design. Keep loads light and reps clean today.`,
  `Back-off week — let the body catch up. Light loads, clean reps.`,
  `Recovery week. The gains from the last three weeks land now. Go light, move well.`,
  `Week 4 — the reset. Don't fight it. Light loads, honest reps, let the body absorb the build.`,
  `This is the easy week. It's not a skip — it's where the progress gets stored. Go light today.`,
  `Back-off by design. The weight drops, the reps stay clean. Don't add plates today.`,
  `Recovery week. The smart lifters treat this one as seriously as the heavy ones. Go light, move honest.`,
];

// Muscle lane, wk1 — "intro" of the volume ramp. Volume starts LOW today
// and climbs across the next two weeks; the coach's job is to set that
// expectation so the user doesn't push loads on a build week where the
// stimulus is meant to come from more sets, not more weight. Follows the
// voice conventions of the wk3/wk4 pools — avoids "block", "deload",
// "mesocycle" (the insider vocabulary the test pins away from). Plain
// language: "the ramp starts here", "the sets climb from here".
const BLOCK_WEEK1_MUSCLE_POOL: readonly string[] = [
  `Week 1 of 4 — easing in. Fewest sets you'll do all month today; the ramp climbs from here.`,
  `Fresh 4-week run. Volume's the lowest it'll be today. Move well; the sets stack over the coming weeks.`,
  `Week 1 — the intro. Light on sets today by design. Dial the form; the volume comes.`,
  `Start of a new 4-week run. Today's the light end of the ramp. Bank clean reps, sets grow from here.`,
  `Week 1 of 4. Don't push loads today — the reps and sets are what grow across the coming weeks.`,
  `Easy entry into the 4-week run. Volume's low today by design. Move honest; the ramp starts next week.`,
  `Week 1. The point today isn't intensity — it's clean setup for the sets that come.`,
  `New 4-week run, easing in. Today's the lightest volume you'll see. Bring the reps, the sets stack later.`,
];

// Muscle lane, wk2 — "build" week. Volume is CLIMBING from wk1; the user
// should feel more sets today than last week. This is where the stimulus
// starts landing.
const BLOCK_WEEK2_MUSCLE_POOL: readonly string[] = [
  `Week 2 of 4 — volume's climbing. More sets today than last week. Keep the reps honest.`,
  `Build week. The sets ramp up from here; hold the loads, let the volume do the work.`,
  `Week 2 — the ramp is on. More sets today, same clean reps. Don't chase weight yet.`,
  `Volume climbing into week 2. Extra sets today land more stimulus, not more strain — keep them clean.`,
  `Build week — sets creep up. The growth signal is in the extra volume; don't rush loads today.`,
  `Week 2 of 4. More work today than last; the body's ready. Reps first, weight later.`,
  `The ramp is climbing. Today has more sets than last week — that's the point. Bring the effort to each.`,
  `Build week. Volume up, load steady. The extra sets are what earn next week's peak.`,
];

// Effort zone — plain language. Hard sets should be close to failure;
// when they're consistently easy, the loads are too light. We avoid "RIR"
// (insider jargon — pinned by tests).
const EFFORT_HIGH_POOL: readonly ((pct: number) => string)[] = [
  (pct) => `Hard sets landing close to failure (${pctInt(pct)}%). That's the growth zone — stay there today.`,
  (pct) => `${pctInt(pct)}% of top sets near the limit. Good — that's where the work lives. Don't ease off today.`,
  (pct) => `Effort dialed in: ${pctInt(pct)}% of sets close to failure. Keep the same approach today.`,
  (pct) => `${pctInt(pct)}% of your hard sets in the right zone. That's not common — keep it there today.`,
  (pct) => `Most of your sets are landing near the limit (${pctInt(pct)}%). Stay honest with the effort today.`,
  (pct) => `${pctInt(pct)}% in the growth zone. The body responds to this kind of effort — bring it again today.`,
  (pct) => `Effort's on point — ${pctInt(pct)}% near failure. The sets that matter are the ones close to the edge. Stay there.`,
  (pct) => `${pctInt(pct)}% of hard sets in the right spot. That's the signal. Don't drift easy today.`,
];

const EFFORT_LOW_POOL: readonly ((pct: number) => string)[] = [
  (pct) => `Hard sets stopping early (${pctInt(pct)}%). There's more in the tank — add weight or chase another rep today.`,
  (pct) => `Only ${pctInt(pct)}% near the limit. Too much left after each set. Push closer to the edge today.`,
  (pct) => `Loads playing it safe (${pctInt(pct)}% in zone). The growth is past where you're stopping. Go heavier today.`,
  (pct) => `${pctInt(pct)}% of sets near failure — the rest had reps left. Today: push the top sets closer to the limit.`,
  (pct) => `You're stopping short (${pctInt(pct)}% in zone). The bar should feel heavy by the last rep. Add weight or chase a rep.`,
  (pct) => `Effort's drifting easy — only ${pctInt(pct)}% near the limit. The work starts where comfort ends. Push today.`,
  (pct) => `${pctInt(pct)}% in the zone. The rest is wasted volume. Make the hard sets actually hard today.`,
  (pct) => `Playing it safe at ${pctInt(pct)}% in zone. That's maintenance, not growth. Add weight or get another rep today.`,
];

// Dialed in — the autoregulator is working. Reference the real (hits,
// total) so the line reads as evidence, not flattery. Test pins "tuned to
// you | dialed in | reading you right" appears in the rotation.
const DIALED_IN_POOL: readonly ((hits: number, total: number) => string)[] = [
  (hits, total) => `${hits} of ${total} sets in the sweet spot — engine tuned to you. Run the plan today.`,
  (hits, total) => `${hits}/${total} hard sets in target. Loads reading you right — follow them today.`,
  (hits, total) => `${hits} of ${total} sets dialed in. Trust today's prescription; just follow it.`,
  (hits, total) => `${hits}/${total} in the zone — the engine knows your numbers now. Run it today.`,
  (hits, total) => `${hits} of ${total} hard sets landed right. That's the system working. Trust the plan today.`,
  (hits, total) => `${hits}/${total} sets in the sweet spot. The loads are following you — just show up and lift.`,
  (hits, total) => `Dialed in: ${hits}/${total} sets on target. The engine's reading you right. Follow the prescription today.`,
  (hits, total) => `${hits} of ${total} sets where they should be. That's not luck — the calibration is working. Trust it today.`,
];

// Whole-training comeback. allowedNumbersFor(comeback) only allows gapDays
// — no other numbers may appear in the line, even in deterministic prose
// (kept consistent so the AI rephraser is bound to the same vocabulary).
const COMEBACK_POOL: readonly ((gapDays: number) => string)[] = [
  (gapDays) => `Back after about ${gapDays} missed sessions. Today just counts — ease the loads and show up.`,
  (gapDays) => `Roughly ${gapDays} sessions missed. Today's job: show up light, no proving. The numbers come back.`,
  (gapDays) => `Welcome back — ${gapDays} sessions off. Ease in today; the old numbers can wait a week.`,
  (gapDays) => `${gapDays} sessions missed. Don't try to make them all up today. Show up, move well, build back.`,
  (gapDays) => `Back after ${gapDays} missed. The first one is always the hardest — just get it done light today.`,
  (gapDays) => `${gapDays} sessions gone. The strength didn't leave; it's just resting. Start easy, find the groove today.`,
  (gapDays) => `You've been out ${gapDays} sessions. No guilt, no catch-up — just an honest, easy session today.`,
  (gapDays) => `Back at it after ${gapDays} missed. The comeback starts with showing up. Go light, move clean today.`,
];

const FALLBACK_POOL: readonly ((workoutType: string, n: number) => string)[] = [
  (workoutType, n) => `Today's a ${workoutType} day — ${n === 1 ? '1 exercise' : `${n} exercises`} ready. Hit them clean.`,
  (workoutType, n) => `${workoutType} day. ${n === 1 ? 'One exercise' : `${n} exercises`} on the list — make every rep honest.`,
  (workoutType, n) => `${workoutType} session queued up. ${n === 1 ? '1 lift' : `${n} lifts`} to go. Show up and do the work.`,
  (workoutType, n) => `Time to train — ${workoutType} today. ${n === 1 ? 'One exercise' : `${n} exercises`}. Keep it simple, hit it clean.`,
  (workoutType, n) => `${workoutType} day, ${n === 1 ? '1 exercise' : `${n} exercises`}. The plan's set — just follow it and log honest.`,
  (workoutType, n) => `Today's ${workoutType}: ${n === 1 ? '1 lift' : `${n} lifts`} ready. Don't overthink it — show up, lift, log.`,
];

// Rest-day baseline — counterpart of FALLBACK_POOL for a day with no
// planned training. Every entry contains "rest" (test pin); never the
// training-briefing template "{type} day" / "on the board" / "exercises".
// Each line is read + REST-APPROPRIATE directive (permission to rest, no
// workout-prep). The dashboard hero forces this onto rest days so a
// workout-shaped read (dialed_in / effort_zone / stall) can never lead.
const REST_DAY_POOL: readonly string[] = [
  `Rest day. Let the work catch up — move easy if you move at all.`,
  `Rest by design today. Take it; recovery is where the gains stick.`,
  `Scheduled rest. Don't train today — light movement only if you want it.`,
  `Rest day. The body builds on the off days as much as the on days. Take it.`,
  `No training today — that's the plan, not a skip. Eat, sleep, move easy.`,
  `Rest. The work you did this week is still landing. Let it.`,
  `Today's a rest day. Don't feel guilty about it — it's half the program.`,
  `Recovery day. The lifts get stronger between sessions, not during. Take it easy.`,
];

// ── Composite (synthesis) pools ─────────────────────────────────────────
// Read + directive. Only the lift name is interpolated; the judgment is
// qualitative so there are no numbers to validate. pushing_hard test pins
// the rotation contains "recovery | ease | pull the volume | protect".
const PUSHING_HARD_POOL: readonly ((lift: string) => string)[] = [
  (lift) => `${lift} climbing but you're running hot. Bank the win, ease the volume today.`,
  (lift) => `Real progress on ${lift}; fatigue stacking. Hold what you've built — don't push for more today.`,
  (lift) => `Pushing hard on ${lift} — recovery slipping. Pull the volume back today. The lift can wait.`,
  (lift) => `${lift} is moving but the body's flagging. Protect the gain: lighter session today, come back full next time.`,
  (lift) => `${lift}'s on a run and you're carrying fatigue. The smart move is ease back today — let recovery catch the progress.`,
  (lift) => `Progress on ${lift} is real, but the energy's dropping. Don't force it today — drop a set, keep the quality.`,
  (lift) => `${lift} climbing while the tank's running low. Back off the volume today; the weight will still be there next week.`,
  (lift) => `You're pushing ${lift} hard and it's working — but the fatigue is too. Ease the volume today, protect the trend.`,
];

const GRINDING_POOL: readonly ((lift: string) => string)[] = [
  (lift) => `${lift} stuck and you're tired. Today we hold the line, not chase it.`,
  (lift) => `Slogging on ${lift} with the tank low. Take a lighter day — the stall breaks when the body recovers.`,
  (lift) => `${lift} stalled, energy low. Light reset today — don't chase the number, chase the groove.`,
  (lift) => `${lift} isn't moving and the fatigue is real. The fix isn't more weight — it's recovery. Go easy today.`,
  (lift) => `Grinding on ${lift} with nothing in the tank. Drop the load today, move well, let the body come back.`,
  (lift) => `${lift}'s stuck and you're running on empty. Stop pushing — a light day here is the right call.`,
  (lift) => `The slog is real on ${lift} — stalled weight, low energy. Pull back today. The break comes when you're rested.`,
  (lift) => `${lift} stalled while you're depleted. Don't grind harder — grind smarter. Ease off today, come back fresh.`,
];

const BACK_ON_TRACK_POOL: readonly ((lift: string) => string)[] = [
  (lift) => `${lift} climbing again since you came back. Keep showing up — don't force the number today.`,
  (lift) => `Back in the groove — ${lift} is moving. Stay the course today; the comeback doesn't need to be fast.`,
  (lift) => `Comeback's working on ${lift}. Same effort today, not bigger numbers. Let it build.`,
  (lift) => `${lift} is responding again after the layoff. Don't rush it — show up, move well, the trend is back.`,
  (lift) => `The return is paying off — ${lift} is climbing. Keep it steady today; no need to chase the old top yet.`,
  (lift) => `${lift} moving again post-comeback. The smart move: same approach today, let the body reprove itself.`,
  (lift) => `You're back and ${lift} shows it. Don't get greedy today — the groove is the goal, not the number.`,
  (lift) => `Comeback's real — ${lift} is on the way back up. Show up again today; consistency finishes what the return started.`,
];

// Plan rationale — split-specific framing. Each entry: ≤130 chars, read +
// directive. Vocabulary obeys allowedNumbersFor (trainingDays + constant 2).
// full_body must not contain `\b1\b` (test pin).
const RATIONALE_FULL_BODY_POOL: readonly string[] = [
  `One day a week → full-body each time. Bring effort to every lift today — nothing gets skipped.`,
  `Full-body plan, so nothing gets skipped. Show up and work the whole list today.`,
  `Once weekly → full-body session. Hit every muscle today, no skip lines.`,
  `Full-body once a week means every lift matters. Bring real effort across the board today.`,
  `One session, whole body. Don't phone in any exercise — they all count today.`,
  `Full-body day: every muscle gets its turn. Show up for all of it, not just the favorites.`,
];

const RATIONALE_UPPER_LOWER_POOL: readonly string[] = [
  `Two days a week → upper/lower split. Today hits its half; the other waits.`,
  `Upper/lower split. Today's half gets all the focus; the rest comes next time.`,
  `Your two days run upper/lower. Today's group — full attention, no shortcuts.`,
  `Upper/lower today. One half gets the work, the other rests. Give it everything.`,
  `Two-day split, upper/lower. Today's half is the only one that matters — train it like it is.`,
  `Upper or lower today — doesn't matter which, both get their turn. Focus on the half in front of you.`,
];

const RATIONALE_PPL_POOL: readonly ((trainingDays: number) => string)[] = [
  (td) => `${td} days a week → push/pull/legs. Today's session has its own focus — bring all the effort to it.`,
  (td) => `With ${td} days, you're on push/pull/legs. Today's group gets everything; the others can wait.`,
  (td) => `${td} sessions, push/pull/legs. Today's group — work it clean, don't spread the effort thin.`,
  (td) => `${td}-day PPL. Each day is one job. Today's job is the group in front of you — bring it.`,
  (td) => `Push/pull/legs on ${td} days. Today is one third of the week. Make it count on its own.`,
  (td) => `${td} days, push/pull/legs split. Today's session is its own thing — don't hold back for tomorrow.`,
];

const RATIONALE_BRO_SPLIT_POOL: readonly ((trainingDays: number) => string)[] = [
  (td) => `${td} days = a muscle a day. Bring all your effort to today's group — it's the only one getting worked.`,
  (td) => `Body-part split fits your ${td} days. Today is one muscle, done properly.`,
  (td) => `${td} sessions, one muscle each. Today's group gets full attention — don't rush it.`,
  (td) => `${td}-day bro split. Today is one muscle's day. Give it everything; the rest get theirs later.`,
  (td) => `One muscle per session, ${td} days a week. Today's group is the only one that matters right now.`,
  (td) => `${td} days, a muscle each. Today's group gets the spotlight — train it like nothing else is on the schedule.`,
];

// Priority personalization — surfaces when the user named a specific muscle
// or compound in onboarding. Priority WINS over goal in the phraser branch
// because it's the more concrete answer ("Bench" beats "Strength"). The
// presented `priority` is sanitized to a display token (Title Case for
// muscle buckets, plain title for compounds). No digits are interpolated;
// validatePhrasing's allowed-number guard never trips.
//
// Compounds use the "getting your X moving" template — the test pin reads
// /bench|squat|deadlift/i for the compound rotation, /chest|back|shoulders|
// arms|legs/i for the bucket rotation.
const PRIORITY_BUCKET_POOL: readonly ((priority: string) => string)[] = [
  (p) => `Built around your ${p} — bring real effort to those exercises today.`,
  (p) => `${p} is your focus — push it harder than the rest today.`,
  (p) => `${p} matters most to you — show up for those lifts and stay clean.`,
  (p) => `Plan's tuned for your ${p}. Today, those exercises get the most attention — don't hold back on them.`,
  (p) => `Your ${p} is the priority. When those lifts come up today, bring the real effort.`,
  (p) => `Built around ${p}. That's where the energy goes today — everything else supports it.`,
];

const PRIORITY_COMPOUND_POOL: readonly ((priority: string) => string)[] = [
  (p) => `Built around getting your ${p} moving. Show up for that lift today.`,
  (p) => `${p} is the lift we're chasing. Bring full effort when it lands today.`,
  (p) => `Plan tuned to push your ${p}. Run that one with intent today.`,
  (p) => `Your ${p} is the headline lift. When it comes up today, treat it like the main event.`,
  (p) => `Built around ${p}. That's the lift that matters most today — give it everything.`,
  (p) => `${p} is the one we're pushing. Today, that lift gets your best set.`,
];

// Goal-only personalization — surfaces when the user picked a goal but no
// specific priority. No interpolation, no digits. Each line ≤ 130 and
// carries a directive cue.
//
// The v2 pools reflect the ACTUAL programming (goalProfile.ts + the RIR
// ladder in loadPrescription.ts):
//   strength — heavy compound 3-5, accessory 8-10, target RIR 1-3 (hold
//     on a clean set with one in the tank, only back off on true failure).
//     Language: "one in the tank," "clean top set," "own the bar."
//   muscle   — hypertrophy compound 6-10, isolation 10-15, target RIR 0-2,
//     volume climbs before load (add a rep before a plate). Language:
//     "add a rep," "close to the edge on the last set."
//   general  — PURE PASSTHROUGH: catalog reps / rest / sets flow through
//     unchanged. No lane-specific dose message applies. Copy stays generic
//     — "show up, train clean, log the work."
const GOAL_STRENGTH_POOL: readonly string[] = [
  `Strength lane — heavy compound, one in the tank. Own the top set today; add weight only when it moves clean.`,
  `Built for heavier bars. Leave a rep in reserve on the big lift today — the number climbs on clean reps, not grinders.`,
  `Strength focus. The compound is the test: a solid rep at target load beats a shaky rep at a bigger number.`,
  `Strength plan. One or two left in the tank is on target today — force it, and next session drops back.`,
  `Tuned for strength. Bring intent to the main lift; keep enough in reserve to make the last rep look like the first.`,
  `Built for strength. Load moves when the top of the range comes up clean — that's the whole progression rule.`,
];

const GOAL_MUSCLE_POOL: readonly string[] = [
  `Size lane — add a rep before you add a plate. Today, push the top set to the edge of the range.`,
  `Growth plan. Zero-to-one in reserve on the last set is on target; the weight climbs only after the reps do.`,
  `Tuned for muscle. Volume before load: try for one more rep in the range today, keep the weight honest.`,
  `Built around growth. Chase the top rep in the range today — a clean 12 earns tomorrow's heavier 8.`,
  `Muscle focus. Last set close to failure, rest full so the next set is real work, not fatigue.`,
  `Size plan. The accessories are the growth driver — push the isolation sets to the edge of clean form.`,
];

const GOAL_GENERAL_POOL: readonly string[] = [
  `Built for steady progress. Show up, train clean, log the work today.`,
  `General progress plan. Keep the work honest — small, regular wins stack.`,
  `Tuned for the long arc. Today: hit it clean, then come back tomorrow.`,
  `Steady progress plan. Today's session doesn't need to be heroic — it needs to happen. Show up.`,
  `Built for the long game. Consistent, clean sessions beat occasional great ones. Train honest today.`,
  `General focus. The best session is the one you actually do. Show up and keep it clean today.`,
];

/** Sanitize a stored priority value for prose. Compounds get a capitalised
 *  noun ("Bench" / "Squat" / "Deadlift"); muscle buckets get a lower-case
 *  noun ("chest" / "back") so the sentence reads naturally ("your chest").
 *  Returns null when the value isn't one of the closed set we expect — the
 *  phraser then falls back to the goal / split branch. */
function displayPriority(p: string | null | undefined): { text: string; kind: 'bucket' | 'compound' } | null {
  if (!p) return null;
  const k = p.trim().toLowerCase();
  switch (k) {
    case 'chest':
    case 'back':
    case 'shoulders':
    case 'arms':
    case 'legs':
      return { text: k, kind: 'bucket' };
    case 'bench':
      return { text: 'Bench', kind: 'compound' };
    case 'squat':
      return { text: 'Squat', kind: 'compound' };
    case 'deadlift':
      return { text: 'Deadlift', kind: 'compound' };
    default:
      return null;
  }
}

// Calibration — pure prose pool. No `trainingDays` reference; only
// constants 2 and 14 are allowed by validatePhrasing. Test pins that the
// rotation matches /calibrat|baseline|learning|dial|tune|honest/.
//
// Re-tuned for the cold-start arc: every line explicitly tells the user
// what to DO this session (find a set with ~2 reps left, rate it) so the
// calibration window is an active hook, not a passive "wait and see". The
// vocabulary still matches the test pin and the no-digit rule (only 2 and
// 14 allowed; the lines use "2" inside "2 reps left").
const CALIBRATION_POOL: readonly string[] = [
  `Starting weights are a guess. Find a set with 2 reps left, rate it — I'll dial in.`,
  `Early days — I'm learning your real numbers. Stop with 2 in the tank, log honestly.`,
  `Calibrating to you. Pick a load you finish with 2 reps left; rate it so I can tune.`,
  `Still finding your numbers. Today: a set with 2 left, rated honestly.`,
  `Baseline week. Stop a set short, rate it honestly — get the loads dialed today.`,
  `I'm learning what you can actually move. Today: find a weight you finish with 2 reps left and rate it.`,
  `Calibration phase — the first couple weeks. Pick a set, leave 2 reps, rate it honest. That's the whole job today.`,
  `Still dialing in your baseline. The honest ratings are what make the plan work — leave 2, rate it real.`,
];

// ── Hero length contract ───────────────────────────────────────────────
// The dashboard hero shows EXACTLY ONE line. 130 chars is the hard cap so
// the editorial-scale Syne Bold fits on 3–4 lines at the responsive size
// inside CoachVoiceHero (numberOfLines={4}, minimumFontScale={0.65}).
// Every authored pool entry above respects this, and the test "every
// hero-eligible line ≤ MAX_HERO_LINE_LEN chars" pins it for future
// contributors. validatePhrasing in coachVoiceAI reads the same constant
// so an AI rephrase over 130 chars falls back to the deterministic line.
export const MAX_HERO_LINE_LEN = 130;

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
    case 'block_position': {
      // wk1/2 pools only fire for muscle-lane observations (buildBlockPosition
      // gates on goal === 'muscle' before emitting them). If a wk1/2
      // observation reaches this phraser without goal === 'muscle' (defensive),
      // fall through to the wk3 pool — better a stale line than a hard crash.
      if (obs.blockWeek === 4) return pick(BLOCK_WEEK4_POOL, obs.factSig);
      if (obs.blockWeek === 3) return pick(BLOCK_WEEK3_POOL, obs.factSig);
      if (obs.blockWeek === 2) return pick(BLOCK_WEEK2_MUSCLE_POOL, obs.factSig);
      return pick(BLOCK_WEEK1_MUSCLE_POOL, obs.factSig);
    }
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
    case 'plan_rationale': {
      // Personalisation branch: a stored priority WINS over the split copy
      // (it's the user's most concrete answer), and a stored goal beats the
      // generic split copy in turn. Both fall back to the split-only pool
      // when absent, which preserves legacy phrasing for any rationale
      // built without opts.
      const prio = displayPriority(obs.priority);
      if (prio) {
        const pool = prio.kind === 'compound' ? PRIORITY_COMPOUND_POOL : PRIORITY_BUCKET_POOL;
        return pick(pool, obs.factSig)(prio.text);
      }
      if (obs.goal === 'strength') return pick(GOAL_STRENGTH_POOL, obs.factSig);
      if (obs.goal === 'muscle') return pick(GOAL_MUSCLE_POOL, obs.factSig);
      if (obs.goal === 'general') return pick(GOAL_GENERAL_POOL, obs.factSig);
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
          return `${obs.trainingDays} training days a week — the plan's built around that cadence. Show up today.`;
      }
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
