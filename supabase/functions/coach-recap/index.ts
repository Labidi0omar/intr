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

const SYSTEM_PROMPT = `You are Intr — a warm, observational strength coach.
The user just finished a workout. Write 1 to 2 sentences that reflect what's
PERSONALLY NOTABLE about THIS session, using only the facts you're given.

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
  - 1 to 2 sentences. Under 200 characters total.
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
  - Plain text. No emojis. No hashtags. No markdown. No questions.

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
// no emoji, no exclamation, ≤160 chars) and falls back to the
// deterministic line on any failure.
//
// JOURNALS: no field in this endpoint accepts free-text from the user's
// journal. The shape is observations[]: { factSig, observationType, facts,
// deterministicLine } — all closed-shape, all numeric except the lift
// name (which the client already controls via the exercise catalog).

const PHRASE_SYSTEM_PROMPT = `You are Intr — a terse, serious-lifter
strength coach. The client gives you a structured observation it has
ALREADY decided to surface, along with a baseline sentence stating that
observation. Your only job: REPHRASE the baseline in the coach's voice,
preserving its exact meaning and every number.

VOICE: declarative, plain, second-person, present-tense, no fluff. Praise
is stated flat — earned, not performed. The coach reads as someone who
notices things, not someone who cheers.

HARD CONSTRAINTS — break any of these and the client throws your line
away and uses the baseline instead. You will never see the user; the
client's validator is the judge:
  - One short sentence. Maximum 140 characters.
  - Use ONLY numbers that appear in the supplied "facts" object. Do not
    invent weights, percentages, days, deltas, RIR values, week counts,
    or any other number. If the baseline says "85 kg", you can say "85"
    or "85 kg" — never "90", never "5 kg up".
  - Do not add advice, recommendations, or prescriptions the baseline
    doesn't already imply. If the baseline says "push or back off",
    you may keep that. You may NOT add "see a physio", "eat protein",
    "add a set", "rest tomorrow".
  - No emoji. No hashtags. No markdown. No exclamation marks. No
    questions. No quotation marks around your sentence.
  - Plain text only.

Return JSON only, exactly:
  { "phrasings": { "<factSig>": "<your sentence>", ... } }
One entry per observation in the input, keyed by factSig. No prose
before or after. No code fences.`;

interface PhraseObservationsRequestBody {
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

  const userMessage = buildPhrasePrompt(observations);

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
      if (typeof v === 'string' && v.trim().length > 0) out[k] = v.trim().slice(0, 200);
    }
  }
  return json({ phrasings: out }, 200);
}

function buildPhrasePrompt(
  observations: PhraseObservationsRequestBody['observations'],
): string {
  let s = `Rephrase each observation below. Preserve every number exactly. One sentence each.\n\n`;
  for (const obs of observations) {
    s += `factSig: ${obs.factSig}\n`;
    s += `type: ${obs.observationType}\n`;
    s += `facts: ${JSON.stringify(obs.facts)}\n`;
    s += `baseline: ${obs.deterministicLine}\n\n`;
  }
  s += `Return JSON: { "phrasings": { "<factSig>": "<sentence>", ... } }`;
  return s;
}
