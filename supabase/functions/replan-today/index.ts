// Replanner — Intr's load-bearing differentiator.
//
// Input  : today's planned exercises + recent context (energy, journals, history)
// Output : an adjusted plan day, list of human-readable changes, and short reasoning
// Safety : LLM output passes through applyReplanSafety() before reaching the client
// Cost   : in-memory cache, 1h TTL, keyed by (user_id, day, energy_score, journal-fingerprint)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  applyReplanSafety,
  describeChanges,
  type PlanDay,
} from "../_shared/safety.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Cache (per-instance, 1h TTL) ─────────────────────────────────────
interface CacheEntry {
  payload: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheGet(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

function cacheSet(key: string, payload: unknown): void {
  cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Intr — an honest, direct strength coach.
The user has told you they're low-energy today. Adjust today's workout to make
it feel achievable without abandoning it. Honor the principle: a hard session
done at 60% is better than no session done at 100%.

You will receive:
- Today's planned exercises (with sets, reps, rest)
- The user's energy score today (1-5)
- Their last 14 days of energy check-ins
- Their last logged weight per exercise
- Their last 5 journal entries (their own words about how they feel)

You must return JSON only, matching this shape exactly:
{
  "adjusted_plan_day": {
    "day": "<same as input>",
    "location": "<same as input>",
    "workoutType": "<same as input>",
    "muscleGroups": [<same as input>],
    "exercises": [
      {
        "name": "<must be one from input exercises>",
        "sets": <integer, must be <= original sets>,
        "reps": "<same range as original or slightly higher rep / lower load>",
        "restSeconds": <same as original>,
        "primaryMuscle": "<same as original>",
        "equipment": "<same as original>",
        "suggestedWeightKg": <number, between 60%-105% of last logged weight>
      }
    ]
  },
  "reasoning": "<25 words MAX. One sentence. Honest, no toxic positivity.>"
}

RULES:
- Never add an exercise not in the input.
- Never increase sets above original.
- Never suggest a weight more than 105% of last logged.
- You may drop exercises entirely if energy is very low (1-2) and the journal
  shows distress. Aim to keep at least the main compound.
- Keep the warm-up exercise (usually first in the list) — never drop it.
- The "reasoning" sentence is the only place you address the user. Speak like
  a coach who knows them. No questions. No emojis. No "you got this."

Output MUST be valid JSON. No prose before or after.`;

interface ReplanRequestBody {
  plan_day: PlanDay;
  energy_score: number;
}

// ── Main handler ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // Auth gate
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
      return json({ error: "Configuration error" }, 500);
    }
    if (!anthropicKey) {
      console.error("Missing ANTHROPIC_API_KEY");
      return json({ error: "Configuration error" }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    // Parse + validate input
    const body = (await req.json()) as Partial<ReplanRequestBody>;
    if (!body.plan_day || typeof body.energy_score !== "number") {
      return json({ error: "plan_day and energy_score required" }, 400);
    }
    if (body.energy_score < 1 || body.energy_score > 5) {
      return json({ error: "energy_score must be 1-5" }, 400);
    }
    const planDay = body.plan_day;
    const energyScore = body.energy_score;

    // ── Monthly usage limit ───────────────────────────────────────────
    // 5 calls/month for free users, 20 for paid. TODO(Sprint 6): swap
    // hardcoded `tier='free'` for a real RC entitlement lookup once the
    // subscriptions table or webhook is wired.
    const tier: "free" | "pro" = "free";
    const monthlyLimit = tier === "pro" ? 20 : 5;

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const { count: usedThisMonth } = await supabase
      .from("replan_calls")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("called_at", monthStart.toISOString());

    if ((usedThisMonth ?? 0) >= monthlyLimit) {
      return json(
        {
          error: "Monthly replan limit reached",
          tier,
          limit: monthlyLimit,
          used: usedThisMonth,
          keep_original: true,
        },
        429
      );
    }

    // Gather context (parallel)
    const [checkinsRes, journalsRes, exerciseLogsRes, profileRes] = await Promise.all([
      // Energy context — sourced from workout_sessions (the dead
      // daily_checkins table is gone). Lossy text energy_level is mapped to
      // 1-5: low→2, normal→3, high→4. mood_tag isn't captured anywhere today.
      supabase
        .from("workout_sessions")
        .select("planned_date, energy_level")
        .eq("user_id", user.id)
        .eq("completed", true)
        .order("planned_date", { ascending: false })
        .limit(14),
      supabase
        .from("journal_entries")
        .select("date, user_text")
        .eq("user_id", user.id)
        .order("date", { ascending: false })
        .limit(5),
      supabase
        .from("exercise_logs")
        .select("exercise_name, weight_kg, logged_date, reps_in_reserve")
        .eq("user_id", user.id)
        // EXCLUSION BOUNDARY: AI replanner sees the same training history
        // the client-side load coach does. Recovery rows must never feed
        // the RIR-driven load prescription. See src/lib/recovery.ts.
        .eq("is_recovery", false)
        .in("exercise_name", planDay.exercises.map(e => e.name))
        .order("logged_date", { ascending: false }),
      supabase
        .from("profiles")
        .select("fitness_level")
        .eq("id", user.id)
        .maybeSingle(),
    ]);

    // Fitness level drives the beginner step-halving inside prescribeLoad.
    // Missing profile → undefined → engine treats user as non-beginner.
    const fitnessLevel = (profileRes.data?.fitness_level ?? undefined) as
      'beginner' | 'intermediate' | 'advanced' | undefined;

    // Compute last weight + last RIR per exercise. lastRir feeds the
    // prescription engine in safety.ts; nulls are fine (means "no signal").
    const lastWeights: Record<string, number> = {};
    const lastRir: Record<string, number | null> = {};
    if (exerciseLogsRes.data) {
      for (const row of exerciseLogsRes.data as {
        exercise_name: string;
        weight_kg: number;
        reps_in_reserve: number | null;
      }[]) {
        if (!(row.exercise_name in lastWeights)) {
          lastWeights[row.exercise_name] = row.weight_kg;
          lastRir[row.exercise_name] = row.reps_in_reserve ?? null;
        }
      }
    }

    // Cache key — fingerprint of all inputs that should give the same output
    const journalFingerprint = (journalsRes.data ?? [])
      .map((j: any) => `${j.date}:${(j.user_text ?? "").slice(0, 50)}`)
      .join("|");
    const cacheKey = await sha256(
      `${user.id}|${planDay.day}|${energyScore}|${journalFingerprint}|${JSON.stringify(lastWeights)}|${JSON.stringify(lastRir)}|${fitnessLevel ?? ''}`
    );

    const cached = cacheGet(cacheKey);
    if (cached) return json(cached, 200);

    // Build the user message
    const userMessage = buildPrompt({
      planDay,
      energyScore,
      checkins: ((checkinsRes.data ?? []) as { planned_date: string; energy_level: string | null }[]).map(s => ({
        date: s.planned_date,
        energy_score: s.energy_level === 'low' ? 2 : s.energy_level === 'high' ? 4 : 3,
        mood_tag: null as string | null,
      })),
      journals: (journalsRes.data ?? []) as { date: string; user_text: string }[],
      lastWeights,
    });

    // Call Claude
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
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

    // Parse JSON from the LLM output
    let parsed: { adjusted_plan_day?: unknown; reasoning?: string };
    try {
      parsed = JSON.parse(extractJson(rawText));
    } catch (e) {
      console.error("LLM returned non-JSON", rawText.slice(0, 200));
      return json({ error: "AI output unparseable, keep original plan" }, 422);
    }

    // Apply safety guardrails. lastRir + energyScore feed the RIR-driven load
    // prescription inside safety; the LLM's suggestedWeightKg is clamped to
    // ±1 plate of that prescription.
    const safety = applyReplanSafety(parsed.adjusted_plan_day, {
      original: planDay,
      lastWeights,
      lastRir,
      energyScore,
      fitnessLevel,
    });
    if (!safety.ok || !safety.plan) {
      console.warn(`safety rejected: ${safety.reason}`);
      return json({ error: `Safety check failed: ${safety.reason}`, keep_original: true }, 422);
    }

    // Drop-guardrail telemetry. When the model removes exercises it wasn't
    // supposed to (energy > 2, or below the low-energy floor), safety.ts
    // restores them and reports the names here. Repeated non-empty logs
    // are the signal that the prompt needs another pass — do not silence
    // this. Tagged 'replan:dropGuard' to match reportSilent conventions on
    // the client side even though this is server-side.
    if (safety.restored && safety.restored.length > 0) {
      console.warn(
        `[replan:dropGuard] restored ${safety.restored.length} dropped exercise(s) at energy=${energyScore}: ${safety.restored.join(", ")}`
      );
    }

    const reasoning = typeof parsed.reasoning === "string"
      ? parsed.reasoning.slice(0, 200).trim()
      : "Adjusted for today's energy.";

    const changes = describeChanges(planDay, safety.plan);

    const payload = {
      adjusted_plan_day: safety.plan,
      changes,
      reasoning,
      usage: {
        tier,
        limit: monthlyLimit,
        used: (usedThisMonth ?? 0) + 1,
      },
    };

    cacheSet(cacheKey, payload);

    // Record the call for monthly-limit accounting. Fire-and-forget; a failed
    // insert just means this user gets one "free" call this month.
    void supabase.from("replan_calls").insert({
      user_id: user.id,
      energy_score: energyScore,
    });

    return json(payload, 200);

  } catch (e) {
    console.error("replan-today error:", e);
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
  // Strip code fences if Claude added them
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
}

interface PromptInput {
  planDay: PlanDay;
  energyScore: number;
  checkins: { date: string; energy_score: number; mood_tag: string | null }[];
  journals: { date: string; user_text: string }[];
  lastWeights: Record<string, number>;
}

function buildPrompt(input: PromptInput): string {
  const { planDay, energyScore, checkins, journals, lastWeights } = input;

  let s = `TODAY'S ENERGY: ${energyScore}/5\n\n`;

  s += `TODAY'S PLAN (${planDay.workoutType}, ${planDay.location}):\n`;
  for (const ex of planDay.exercises) {
    const last = lastWeights[ex.name];
    const lastStr = last ? ` (last logged: ${last} kg)` : ` (no history)`;
    s += `- ${ex.name}: ${ex.sets} × ${ex.reps}, rest ${ex.restSeconds}s${lastStr}\n`;
  }

  if (checkins.length > 0) {
    s += `\nLAST ${checkins.length} CHECK-INS:\n`;
    for (const c of checkins) {
      const mood = c.mood_tag ? `, mood: ${c.mood_tag}` : "";
      s += `- ${c.date}: energy ${c.energy_score}/5${mood}\n`;
    }
  }

  if (journals.length > 0) {
    s += `\nLAST ${journals.length} JOURNAL ENTRIES (verbatim):\n`;
    for (const j of journals) {
      const snippet = (j.user_text ?? "").slice(0, 300).replace(/\s+/g, " ").trim();
      s += `- ${j.date}: "${snippet}"\n`;
    }
  }

  s += `\nAdjust today's plan. Return JSON only. Keep the warm-up. Be honest.`;
  return s;
}
