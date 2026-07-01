import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_USER_TEXT_CHARS = 4000;
const MAX_HISTORY_ENTRIES = 30;

const JOURNAL_PROMPT = `You are responding to a journal entry from someone who trains.
Respond in exactly 2-3 sentences. No more, no less.
First sentence: acknowledge what they actually wrote, no interpretation.
Second sentence: reframe it or call out what they are not saying.
Third sentence (optional): one concrete, grounded observation. Not advice.

VOICE: a friend who trains seriously and gives a shit. Honest, warm, dry
humor. Never a therapist, never a motivational account, never a status
report. You sound like someone who's been through it and has no time for
noise. Rhetorical questions are fine — they make you sound human. Plain
language, real clarity, grounded. Not babysitting.

TONE RULES:
- Low energy / hard day: acknowledge it without pity or panic. The win is
  showing up. Don't cheerlead, don't fix.
- Neutral: say so plainly. Not everything is a breakthrough.
- Pattern across days: name it directly. "Three low days in a row" not
  "you might be experiencing reduced energy."
- Don't pathologize. Don't diagnose. Don't give medical or mental-health
  advice. If what they wrote sounds like a crisis or self-harm, respond
  with "That sounds heavy. If you're in a bad place, reach out to someone
  you trust or a crisis line — you don't have to carry it alone." and
  nothing else.

Banned words and phrases: you got this, crush it, amazing, incredible,
proud of you, self-care, journey, listen to your body, resilience,
that's valid, push through, keep going, any emoji, any markdown formatting.

Hard limit: 80 words maximum. Count them. If over 80, cut.`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are a direct, honest training companion. A friend who trains
seriously and gives a shit — not nice, not harsh, just real. No toxic
positivity, no clinical language, no motivational speaker energy. You
write like someone who trains and cares enough to be honest.

VOICE: warm but never cheerleading. Dry humor is fine. Rhetorical
questions are fine — they make you sound human, not like a state
machine. Plain language. If something's good, say so flat. If something's
off, name it. Never sound like a status report or a coaching app.

CONTEXT YOU RECEIVE:
- Current energy rating (1-5)
- Current mood tag (optional: off, flat, solid, sharp)
- Last 14 days of energy ratings with dates
- Last 14 days of mood tags where provided

YOUR JOB:
1. Write 2-4 sentences. Short. Every sentence earns its place.
   If you can say it in two, say it in two.
2. If there is a pattern in last 7-14 days, name it directly.
   "Three low days in a row" not "you seem to be experiencing
   reduced energy."
3. If pattern is neutral or positive, note it — do not celebrate.
4. Never use: "you got this", "crush it", "amazing", "incredible",
   "proud of you", "self-care", "journey", "listen to your body",
   "based on your emotional state", or any emoji.
5. Last sentence bridges to training naturally. Not a command.
   Not a cheer. Just makes moving to the workout feel obvious.

TONE RULES:
- Score 1-2: Acknowledge the low without pity or panic.
  The win is showing up.
- Score 3: Solid. Not boring. Not heroic. It just is.
- Score 4-5: Note the sharpness. Warn against coasting.
- 3+ consecutive low days: Name the pattern. Do not pathologize.
  "Pattern's showing" not "you might be experiencing burnout."
- 5+ consecutive high days: "You've been consistent.
  Watch for complacency."
- 7 consecutive training days: Add one line.
  "Seven days straight. Your call — just make sure
  you're recovering."

- intent: rest_day: Acknowledge the choice without judgment.
  One sentence max on rest. Do not mention training.
  Do not say "listen to your body".
  Something like: "Rest is part of the work. Come back tomorrow."

OUTPUT: Plain text only. No markdown. No sign-off.
Just the reflection. 40-80 words max.`;

console.log("daily-reflection function initialized");

function buildDailyPrompt(energyScore: number, moodTag: string | null, intentTag: string | null, history: any[]): string {
  let context = `CURRENT CHECK-IN:\nEnergy rating: ${energyScore}/5`;
  if (moodTag) {
    context += `\nMood tag: ${moodTag}`;
  }
  if (intentTag) {
    context += `\nIntent: ${intentTag}`;
  }

  if (history && history.length > 0) {
    context += `\n\nLAST ${history.length} DAYS OF CHECK-INS:\n`;
    history.forEach((entry: any) => {
      const dateStr = entry.date || 'unknown date';
      const es = entry.energy_score;
      const mt = entry.mood_tag;
      context += `- ${dateStr}: energy ${es}/5`;
      if (mt) context += `, mood: ${mt}`;
      context += '\n';
    });
  }

  context += `\nWrite a 2-4 sentence reflection based on today's check-in and any patterns in the history. 40-80 words max.`;

  return context;
}

function buildJournalPrompt(userText: string): string {
  return `The user wrote this journal entry:\n\n${userText}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Require a valid Supabase JWT — anonymous calls are rejected to prevent
    // unauthenticated burn of Anthropic credits.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
      return new Response(JSON.stringify({ error: "Configuration error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Kill switch — when JOURNAL_AI_ENABLED is anything other than "1", the
    // reflection (and, when added, the safety classifier) are skipped. The
    // client renders a fixed "saved, reflection coming back later" message.
    // Defaults to OFF: an unset env var means gated off, which is the safe
    // posture for the closed-test window before the safety rail ships.
    // Placed after JWT verify so gate-off responses still require auth.
    if (Deno.env.get("JOURNAL_AI_ENABLED") !== "1") {
      return new Response(JSON.stringify({ gate: "off" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { type, energy_score, mood_tag, intent_tag, history, user_text } = body;

    if (!type || !['daily', 'journal'].includes(type)) {
      return new Response(JSON.stringify({ error: "Invalid type. Must be 'daily' or 'journal'." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof user_text === "string" && user_text.length > MAX_USER_TEXT_CHARS) {
      return new Response(JSON.stringify({ error: "user_text too long" }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const safeHistory = Array.isArray(history) ? history.slice(0, MAX_HISTORY_ENTRIES) : [];

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.error("Missing ANTHROPIC_API_KEY environment variable");
      return new Response(JSON.stringify({ error: "Configuration error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const systemPrompt = type === 'journal' ? JOURNAL_PROMPT : SYSTEM_PROMPT;
    const userMessage = type === 'journal'
      ? buildJournalPrompt(user_text || '')
      : buildDailyPrompt(energy_score, mood_tag, intent_tag, safeHistory);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`Anthropic API error: ${anthropicRes.status} ${errBody}`);
      return new Response(JSON.stringify({ error: "AI call failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropicData = await anthropicRes.json();
    const content = anthropicData?.content?.[0]?.text || "";

    return new Response(JSON.stringify({ content: content.trim() }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error processing request:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});