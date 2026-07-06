// Post-workout coach recap — short, personalized "what just happened."
//
// Goal: the user should feel the coach understands THIS session — not a
// generic congratulations. We achieve that by giving the model a rich
// deterministic context (today's logs + per-lift trend + RIR target +
// deload flag + low-energy-trained + streak), constraining it to a tight
// salience hierarchy, and forbidding it from inventing anything.
//
// Cost shape: exactly one Anthropic call per finished workout. The client
// caches the result in AsyncStorage keyed by (user_id, date) so reopening
// the complete screen never re-bills. No per-set calls.
//
// Failure mode: the client treats any error from this function (timeout,
// missing key, non-200, garbage body) as "no AI" and falls back to a pure
// deterministic recap (src/lib/coachRecap.ts::buildFallbackRecap). The
// finish flow MUST NOT depend on this function succeeding, and the popup
// ALWAYS shows.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Prompt ───────────────────────────────────────────────────────────
// Hard guardrails. The model phrases numbers the client supplied, nothing
// more. The salience hierarchy mirrors the deterministic fallback exactly
// — same priority order — so AI-on / AI-off feels like the same coach,
// just better worded.
//
// v3 voice: warmer, more human. Rhetorical questions allowed. Exclamation
// allowed on genuine milestones (PRs, new highs). Few-shot examples anchor
// the voice better than rules. The model is asked to REFLECT, not just
// restate — add a beat, make it land, sound like a person who trains.

const SYSTEM_PROMPT = `You are Intr — a strength coach who trains seriously and gives a shit.
The user just finished a workout. Write 1 to 2 sentences that reflect what's
PERSONALLY NOTABLE about THIS session, using only the facts you're given.

VOICE: a friend who trains, not a motivational poster. Dry humor, honest,
warm without cheerleading. You notice the right thing and say it plainly.
Occasional rhetorical questions are fine. Exclamation marks are allowed on
genuine milestones (a PR, a new high) but never on ordinary sessions.
Never sound like a status report or a corporate coaching app.

SALIENCE — pick the 1 to 2 most meaningful things in this priority order:
  1. A PR (new best in the recent window) — name the lift and the weight.
  2. A lift that progressed THIS session — weight up vs last session.
  3. Hit target effort — at least one set landed at RIR 1 or 2 (the
     autoregulator's target zone).
  4. Showed up despite low energy — energy was 1 or 2 and they still trained.
  5. A streak milestone — 5, 7, 10, 14, 21, 30, 50, 100 days.
  6. Otherwise — one specific light observation (workout type, top lift,
     lift count). Always concrete, never generic.

CONTINUITY: when natural, reference the trajectory ("up from 78 last week",
"third week on bench", "RIR 1 again this week") to show you've been paying
attention. Only use numbers from per_lift_trend or today_logs — never invent.

COLD START (cold_start: true): say so warmly — "first one logged" — don't
strain to reflect on absent history.

DELOAD (deload: true): the prescribed dose was REDUCED on purpose. Do NOT
celebrate "progression" — frame it as the recovery week it is.

HARD RULES:
  - 1 to 2 sentences. Under 280 characters total.
  - Reference ONLY values present in the user message — exercise names,
    weight_kg, reps, rir, streak, block_week, per_lift_trend entries,
    workout_type. NEVER invent trajectory, weights, reps, RIR, or PRs.
  - NEVER give medical, injury, training, or nutrition advice. No "ice it",
    "rest day tomorrow", "go heavier next time", "add a set", "see a physio",
    "eat X grams of protein". The autoregulator handles next session — your
    job is to reflect THIS one.
  - Acknowledge a weak session honestly and supportively: low energy, missed
    targets, weight dropped. Warm, never discouraging, never judgmental,
    never toxic positivity ("you crushed it!", "amazing job!!").
  - Plain text. No emojis. No hashtags. No markdown.

EXAMPLES of the voice (these are illustrative, not templates to copy):
  PR:        "Squat PR at 100 kg — that's a real one. Bank it; don't chase another today."
  Progressed: "Bench up to 85 from 82.5 last week. The trajectory's right — keep the reps clean."
  Target zone: "Five lifts in the RIR 1-2 zone. The engine has real signal now. Follow it next time."
  Low energy:  "Energy was a 2 and you still got four lifts in. That's the build, not the noise."
  Streak:     "Day 14. Two weeks of showing up — that's what moves it."
  Default:    "Push done — five lifts, bench at 85 kg. Cleanly logged."
  Cold start: "First one logged. I'll track your progress from here."
  Deload:     "Recovery week — exactly the session it's meant to be. Light dose at 70 kg on bench."

Return JSON only, exactly: { "message": "<your 1-2 sentence recap>" }
No prose before or after. No code fences.`;

// Match the client-side CoachRecapContext in src/lib/coachRecap.ts. New
// fields are validated softly (presence + type) so an older client that
// hasn't shipped the extras still gets a valid response.
interface RecapRequestBody {
  today_logs: Array<{
    exercise_name: string;
    weight_kg: number | null;
    reps: string | number | null;
    rir: number | null;
  }>;
  prs: string[];
  energy_score: number;
  streak: number;
  block_week?: number;
  vs_last_session: string;
  workout_type?: string;
  per_lift_trend?: Array<{
    name: string;
    recent: Array<{ weight_kg: number | null; rir: number | null; days_ago: number }>;
  }>;
  target_zone_hit?: boolean;
  deload?: boolean;
  trained_despite_low_energy?: boolean;
  cold_start?: boolean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
      return json({ error: "Configuration error" }, 500);
    }
    if (!anthropicKey) {
      // Missing key is a hard 500 — the client falls back to the
      // deterministic recap. The popup still shows.
      console.error("Missing ANTHROPIC_API_KEY");
      return json({ error: "Configuration error" }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    // Parse + validate the required fields strictly. Optional fields are
    // type-checked only when present.
    const body = (await req.json()) as Partial<RecapRequestBody> & Partial<PhraseObservationsRequestBody>;

    // ── Sibling action: phrase deterministic coach observations ────────
    // Dispatched by body shape so we don't deploy a second function. If the
    // body carries `observations`, route to the rephraser; otherwise fall
    // through to the post-workout recap path below.
    if (Array.isArray(body.observations)) {
      return await handlePhraseObservations(body as PhraseObservationsRequestBody, anthropicKey);
    }

    if (!Array.isArray(body.today_logs)) return json({ error: "today_logs required" }, 400);
    if (!Array.isArray(body.prs)) return json({ error: "prs required" }, 400);
    if (typeof body.energy_score !== "number" || body.energy_score < 1 || body.energy_score > 5) {
      return json({ error: "energy_score must be 1-5" }, 400);
    }
    if (typeof body.streak !== "number" || body.streak < 0) {
      return json({ error: "streak must be a non-negative number" }, 400);
    }
    if (typeof body.vs_last_session !== "string") {
      return json({ error: "vs_last_session must be a string" }, 400);
    }

    const userMessage = buildPrompt(body as RecapRequestBody);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`Anthropic error: ${anthropicRes.status} ${errBody}`);
      return json({ error: "AI call failed" }, 502);
    }

    const anthropicData = await anthropicRes.json();
    const rawText: string = anthropicData?.content?.[0]?.text ?? "";

    let parsed: { message?: string };
    try {
      parsed = JSON.parse(extractJson(rawText));
    } catch {
      console.error("LLM returned non-JSON:", rawText.slice(0, 200));
      return json({ error: "AI output unparseable" }, 422);
    }

    const raw = typeof parsed.message === "string" ? parsed.message.trim() : "";
    if (!raw) return json({ error: "Empty recap from model" }, 422);

    // Defense in depth: hard-cap length so a model glitch can't dump 4kB into
    // the bottom sheet. The system prompt already asks for ≤200 chars.
    const message = raw.slice(0, 280);

    return json({ message }, 200);

  } catch (e) {
    console.error("coach-recap error:", e);
    return json({ error: "Internal Server Error" }, 500);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
}

function buildPrompt(input: RecapRequestBody): string {
  const {
    today_logs, prs, energy_score, streak, block_week, vs_last_session,
    workout_type, per_lift_trend, target_zone_hit, deload,
    trained_despite_low_energy, cold_start,
  } = input;

  let s = `TODAY'S SESSION${workout_type ? ` (${workout_type})` : ""}:\n`;
  if (today_logs.length === 0) {
    s += `- (no exercises were logged with weights)\n`;
  } else {
    for (const log of today_logs) {
      const weight = log.weight_kg === null ? "bodyweight" : `${log.weight_kg} kg`;
      const reps = log.reps != null ? `${log.reps} reps` : "reps unknown";
      const rir = log.rir != null ? `, RIR ${log.rir}` : "";
      s += `- ${log.exercise_name}: ${weight} × ${reps}${rir}\n`;
    }
  }

  s += `\nENERGY TODAY: ${energy_score}/5\n`;
  s += `CURRENT STREAK: ${streak} day${streak === 1 ? "" : "s"}\n`;
  if (typeof block_week === "number") {
    s += `BLOCK WEEK: ${block_week} of 4\n`;
  }

  // Flags — the model uses these to pick the right tone / salience tier.
  s += `\nFLAGS:\n`;
  s += `- cold_start: ${!!cold_start}\n`;
  s += `- deload: ${!!deload}\n`;
  s += `- target_zone_hit: ${!!target_zone_hit}\n`;
  s += `- trained_despite_low_energy: ${!!trained_despite_low_energy}\n`;

  if (prs.length > 0) {
    s += `\nPRs HIT THIS SESSION: ${prs.join(", ")}\n`;
  }

  // Per-lift trend — drives "trajectory" continuity in the prose. Only
  // include lifts that actually have prior history; an entry with empty
  // recent[] tells the model "this is the user's first time on this lift."
  if (Array.isArray(per_lift_trend) && per_lift_trend.length > 0) {
    s += `\nPER-LIFT TREND (most recent prior sessions, newest first):\n`;
    for (const t of per_lift_trend) {
      if (!t.recent || t.recent.length === 0) {
        s += `- ${t.name}: (first time)\n`;
        continue;
      }
      const parts = t.recent.map(r => {
        const w = r.weight_kg === null ? "bw" : `${r.weight_kg}kg`;
        const rir = r.rir != null ? ` @RIR${r.rir}` : "";
        return `${w}${rir} (${r.days_ago}d ago)`;
      });
      s += `- ${t.name}: ${parts.join(" → ")}\n`;
    }
  }

  if (vs_last_session.trim().length > 0) {
    s += `\nVS LAST SESSION: ${vs_last_session.trim()}\n`;
  }

  s += `\nWrite the recap. JSON only.`;
  return s;
}

// ════════════════════════════════════════════════════════════════════════
// ── Sibling action: phrase deterministic coach observations ────────────
// ════════════════════════════════════════════════════════════════════════
//
// The continuity engine (src/lib/coachObservations + coachVoice) already
// produces a complete deterministic line for every observation. This
// endpoint REPHRASES that line in the brand voice using only the numbers
// the client supplied. The model is a stylist, not an author: it cannot
// invent facts, change judgment, or take on advice the deterministic
// didn't already imply. The client validates the output (no inventions,
// no emoji, ≤130 chars, directive or question present) and falls back to
// the deterministic line on any failure.
//
// v3 voice: warmer, more human, few-shot examples. The model is asked to
// IMPROVE the line — restructure, add a beat, make it land — not just
// restate it. Rhetorical questions and exclamation on milestones allowed.
//
// JOURNALS: no field in this endpoint accepts free-text from the user's
// journal. The shape is observations[]: { factSig, observationType, facts,
// deterministicLine } — all closed-shape, all numeric except the lift
// name (which the client already controls via the exercise catalog).

const PHRASE_SYSTEM_PROMPT = `You are Intr — a strength coach who trains seriously and gives a shit.
The client gives you a structured observation it has ALREADY decided to
surface, along with a baseline sentence stating that observation. Your
job: REWRITE the baseline in the coach's voice — better, warmer, more
human. Not a restatement. An improvement.

VOICE: a friend who trains, not a motivational poster. Dry humor, honest,
warm without cheerleading. You notice the right thing and say it plainly.
Declarative, second-person, present-tense. Occasional rhetorical questions
are fine — they sound like a person, not a state machine. Exclamation
marks allowed on genuine milestones (PRs, new highs, streak milestones)
but never on ordinary reads.

READ + DIRECTIVE: every baseline carries two beats — where the user is
(the read: a stall, a climb, a recovery week, a streak) AND what to do
today (the directive: "get one more rep before adding weight", "cement
the form, don't chase another today", "ease the volume"). Your rewrite
MUST keep both. A rewrite that drops the directive — that becomes pure
description ("Bench hit a new high", "Squat moved up to 100 kg") — is
unacceptable; rewrite or fall back. The directive can be a question
("ready to chase it?") or implicit ("the break comes from reps, not
weight") — it doesn't have to be an imperative verb.

HARD CONSTRAINTS — break any of these and the client throws your line
away and uses the baseline instead. You will never see the user; the
client's validator is the judge:
  - One short sentence. MAXIMUM 130 characters total (hard cap — the
    dashboard hero renders ONE line at large editorial scale and longer
    output explodes the layout).
  - Use ONLY numbers that appear in the supplied "facts" object. Do not
    invent weights, percentages, days, deltas, RIR values, week counts,
    or any other number. If the baseline says "85 kg", you can say "85"
    or "85 kg" — never "90", never "5 kg up".
  - Keep the baseline's directive (the "what to do today" beat). You may
    not add NEW prescriptions the baseline doesn't already imply: no
    "see a physio", "eat protein", "add a set", "rest tomorrow".
  - No emoji. No hashtags. No markdown. No quotation marks around your
    sentence.
  - Plain text only.

FEW-SHOT EXAMPLES — study the upgrade from baseline to good rewrite.
The baseline is the deterministic line; your job is to make it land
better without changing the meaning or the numbers.

Observation: lift_progression:stall, Bench stuck at 80kg for 3 sessions
Baseline: "Bench stuck at 80 kg for 3 sessions. Get one more rep before adding weight."
Good: "80 kg has been the wall for three sessions. Don't add weight — get one more rep today."
Good: "Bench isn't budging from 80. That's a checkpoint, not a plateau. Chase the rep."
Good: "Three sessions at 80 kg. The break comes from reps, not weight. Push for one more."

Observation: lift_progression:up (new high), Bench hit 85kg
Baseline: "Bench hit a new top — 85 kg. Cement the form; don't chase another today."
Good: "New high on bench: 85 kg! Cement it today — don't chase another this week."
Good: "85 kg — a new best on bench. The smart move: hold the load, own the reps."

Observation: session_pr, Squat PR at 100kg (was 95)
Baseline: "Squat PR — 100 kg, past 95. Take the win; don't chase another today."
Good: "Squat PR at 100 kg — that's a real one! Bank it; the next jump isn't today."
Good: "100 kg on squat, past 95. Take the win. The form has to carry the number now."

Observation: consistency, 12 of 14 days trained
Baseline: "12 of last 14 days in. Keep showing up — that's what moves it."
Good: "12 of 14 days. That's not luck, that's habit. Show up again today — it compounds."
Good: "You've trained 12 of the last 14 days. The body's paying attention. Don't break the pattern."

Observation: block_position:4, recovery week
Baseline: "Recovery week. Go lighter on purpose — that's where the work sticks."
Good: "Recovery week. The gains from the last three weeks land now. Go light, move well."
Good: "This is the easy week. It's not a skip — it's where the progress gets stored. Go light today."

Observation: block_position:1, muscle lane — INTRO of the volume ramp
Baseline: "Fresh block, week 1 of 4. Ease in — the sets climb over the next two weeks."
Good: "Week 1 of 4. Lowest volume of the block by design — dial the reps in, the sets ramp from here."
Good: "New block, easy entry. Today's the light end; volume climbs over the next two weeks."
NOTE: On wk1 the sets are DELIBERATELY LOWER than they'll be at peak. Do NOT
tell the user to "push harder" or "add a plate" — the point is a clean intro,
volume will come.

Observation: block_position:2, muscle lane — BUILD week
Baseline: "Week 2 of 4 — volume's climbing. More sets today than last week. Keep the reps honest."
Good: "Build week. Sets are up from last week — that's where the growth signal is. Reps clean."
Good: "Week 2. More work than wk1 today. The extra sets earn next week's peak — don't skip them."
NOTE: On wk2 the ADDED VOLUME IS THE PROGRESSION, not more weight. Never say
"add a plate today" — the muscle lane climbs REPS AND SETS before load. The
extra sets today are the whole point; loads stay steady.

Observation: progress_ready, Bench parked at 80 kg for 2 weeks, today's energy is high
Baseline: "Energy's high and Bench has sat at the same weight for 2 weeks — time to push. Add a little."
Good: "Bench hasn't moved in 2 weeks and today you've got the tank. Add a little; make the number climb."
Good: "2 weeks parked on Bench at 80 kg, energy's there today — push it. A small bump is exactly right."
NOTE: This observation ALWAYS tells the user to ADD WEIGHT today. The engine
is bumping the prescribed load on the workout card in the same session, so
the coach and the number agree by construction. NEVER rephrase this as
"hold the load", "back off", "one more rep", or "clean reps at the same
weight" — that would contradict what the workout screen is telling the
user to do. The directive is unambiguous: push, add a little, nudge it up.

Observation: deload_offer with action='skip' — scheduled deload can be skipped
Baseline: "You've been trending well and week 4's a deload — skip it if you've got the tank. Tap to keep pushing."
Good: "Trend's holding — you can skip this deload if the tank's full. Tap to keep the block honest."
Good: "Deload week's due, but your recovery says you don't need it yet. Tap to skip it and keep building."
NOTE: Every rephrase MUST end with the "tap" cue — that's the accept-button
prompt for the dashboard action. Never remove or soften the directive.

Observation: deload_offer with action='early' — pull the deload forward
Baseline: "Trend's slipping — the deload can come now, not week 4. Tap to pull it forward and reset."
Good: "You've been running hot. Pull the deload forward — tap to reset this week and come back fresh."
Good: "Recovery's dropping. Take the deload now, not later — tap to move it to this week."
NOTE: Same "tap" invariant as above. Never say "skip" here — the action is
to bring the deload FORWARD, not remove it.

Observation: deload_heads_up — scheduled deload is 5 days out
Baseline: "Next week is a deload — back off and recover. About 5 days out. Empty the tank this week; the reset earns it."
Good: "Deload in 5 days. Push through this week; the light week's around the corner."
Good: "About 5 days until the reset. Bring it hard until then — the deload lands next."
NOTE: NARRATION only — this is a heads-up, not a call to action. Do NOT
include "tap" or any accept-button language. The user isn't being asked
to decide anything; they're being told what's coming.

Observation: grinding, Bench stalled + low energy
Baseline: "Bench stuck and you're tired. Today we hold the line, not chase it."
Good: "Bench isn't moving and the tank's low. Don't grind harder — a light day here is the right call."
Good: "The slog is real on bench. Pull back today; the stall breaks when you're rested."

Observation: comeback, 10 missed sessions
Baseline: "Back after about 10 missed sessions. Today just count — ease the loads."
Good: "Back after 10 missed. No guilt, no catch-up — just an honest, easy session today."
Good: "10 sessions gone. The strength didn't leave; it's just resting. Start easy, find the groove."

Observation: effort_zone:low, only 25% in zone
Baseline: "Hard sets stopping early (25%). Add weight or push for one more rep today."
Good: "Only 25% of sets near the limit. There's more in the tank — push the top sets closer today."
Good: "Stopping short at 25% in zone. The growth is past where you're stopping. Go heavier today."

Observation: rest_day
Baseline: "Rest day. Let the work catch up — move easy if you move at all."
Good: "Rest day. The body builds on the off days as much as the on days. Take it."
Good: "No training today — that's the plan, not a skip. Eat, sleep, move easy."

BAD rewrites (these would be rejected by the validator):
  - "Great job on bench! Keep pushing!"           (cheerleading, no directive, invented tone)
  - "Bench is at 80 kg and you should add weight." (contradicts the baseline's directive)
  - "Bench stuck at 90 kg."                        (invented number — 90 isn't in the facts)
  - "Bench hit a new high."                        (dropped the directive — pure description)

GOAL LANE — the facts object may carry a "goal" field with one of three
values. It signals the programming lane the client is running; match your
voice to it:
  - strength — heavy compound work, target RIR 1-3, load progresses only
    when reps top the range cleanly. Language cues: "one in the tank,"
    "clean top set," "own the bar." NEVER say "chase reps to failure" or
    "push past the edge" — that's the wrong lane.
  - muscle — hypertrophy focus, target RIR 0-2, volume climbs before load
    (add a rep before a plate). Language cues: "add a rep," "last set to
    the edge," "chase the top of the range." NEVER say "leave reps in the
    tank" or "stay fresh" as a directive — the growth is at the edge.
  - general — pass-through lane, no lane-specific dose changes. Keep the
    voice generic ("train clean," "show up," "log the work"). Don't
    invent lane cues — this user isn't running a specialized programme.
    Same treatment when goal is absent.
Never invent goal-specific directives the baseline doesn't imply — the
baseline is the truth. This section is voice guidance, not a mandate to
reshape the message.

If a user name is supplied, use it OCCASIONALLY — not every line, maybe
one in five. It should feel like a friend who knows your name, not a
brand email.

Return JSON only, exactly:
  { "phrasings": { "<factSig>": "<your sentence>", ... } }
One entry per observation in the input, keyed by factSig. No prose
before or after. No code fences.`;

interface PhraseObservationsRequestBody {
  /** Optional user name for light personalization. The prompt instructs
   *  the model to use it occasionally, not every line. */
  userName?: string;
  observations: Array<{
    factSig: string;
    observationType: string;
    facts: Record<string, unknown>;
    deterministicLine: string;
  }>;
}

async function handlePhraseObservations(
  body: PhraseObservationsRequestBody,
  anthropicKey: string,
): Promise<Response> {
  // Strict-validate the shape. A malformed entry is dropped (not 4xx) so a
  // partial batch still gets phrased.
  const observations = body.observations.filter(o =>
    o
    && typeof o.factSig === 'string' && o.factSig.length > 0
    && typeof o.observationType === 'string'
    && o.facts && typeof o.facts === 'object'
    && typeof o.deterministicLine === 'string' && o.deterministicLine.length > 0
  );
  if (observations.length === 0) {
    return json({ phrasings: {} }, 200);
  }

  const userMessage = buildPhrasePrompt(observations, body.userName);

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: PHRASE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!anthropicRes.ok) {
    const errBody = await anthropicRes.text();
    console.error(`Anthropic error (phrase): ${anthropicRes.status} ${errBody}`);
    return json({ error: "AI call failed" }, 502);
  }

  const anthropicData = await anthropicRes.json();
  const rawText: string = anthropicData?.content?.[0]?.text ?? "";

  let parsed: { phrasings?: Record<string, unknown> };
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    console.error("Phraser LLM returned non-JSON:", rawText.slice(0, 200));
    return json({ error: "AI output unparseable" }, 422);
  }

  const out: Record<string, string> = {};
  if (parsed.phrasings && typeof parsed.phrasings === 'object') {
    for (const [k, v] of Object.entries(parsed.phrasings)) {
      if (typeof v === 'string' && v.trim().length > 0) out[k] = v.trim().slice(0, 130);
    }
  }
  return json({ phrasings: out }, 200);
}

function buildPhrasePrompt(
  observations: PhraseObservationsRequestBody['observations'],
  userName?: string,
): string {
  let s = `Rephrase each observation below. Preserve every number exactly. One sentence each.\n\n`;
  if (userName && userName.trim().length > 0) {
    s += `User's name: ${userName.trim()}. Use it occasionally, not every line.\n\n`;
  }
  for (const obs of observations) {
    s += `factSig: ${obs.factSig}\n`;
    s += `type: ${obs.observationType}\n`;
    s += `facts: ${JSON.stringify(obs.facts)}\n`;
    s += `baseline: ${obs.deterministicLine}\n\n`;
  }
  s += `Return JSON: { "phrasings": { "<factSig>": "<sentence>", ... } }`;
  return s;
}
