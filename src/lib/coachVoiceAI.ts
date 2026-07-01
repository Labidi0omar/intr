// AI rephrasing layer for the continuity engine.
//
// Architecture (do NOT erode):
//   BRAIN (coachObservations) decides WHAT to notice — structured facts.
//   MOUTH (coachVoice.phraseObservation) writes the deterministic line —
//     ground truth, always renderable, the floor on quality.
//   AI VOICE (this file) is a REPHRASER, not an author. It receives the
//     same structured facts plus the deterministic line and asks an edge
//     function (which holds the API key) to restate the same meaning in
//     the brand voice. The result is validated client-side; any failure
//     mode falls back to the deterministic line.
//
// What the AI is NEVER allowed to do:
//   • Invent numbers (validatePhrasing blocks any digit not in obs.facts).
//   • Add advice not implied by the deterministic line (system prompt
//     forbids it; validator can't fully enforce — relies on the prompt).
//   • See journal text (the payload builder is closed-shape; the
//     "no journal fields" invariant is asserted in the unit tests).
//   • Block the append (every wire-up does deterministic FIRST, fires the
//     upgrade as a fire-and-forget; the upgrade surfaces next focus).
//
// Caching: a validated AI line is cached by factSig in AsyncStorage. Since
// factSig only changes when the underlying fact changes, each fact is
// phrased by the AI at most once over the user's lifetime.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { reportSilent } from './errorReporting';
import { COACH_AI_VOICE } from '../constants/buildInfo';
import type { Observation } from './coachObservations';
import { MAX_HERO_LINE_LEN, phraseObservation } from './coachVoice';

// ── Types ──────────────────────────────────────────────────────────────

/** The closed-shape payload that goes over the wire. Used as the contract
 *  in the "no journal fields" test — anything not on this interface CANNOT
 *  reach the edge function via this client. */
export interface EdgePhrasePayload {
  /** Optional user name for light personalization. The prompt instructs
   *  the model to address the user by name occasionally, not every line.
   *  Never required; older callers that omit it are unaffected. */
  userName?: string;
  observations: Array<{
    factSig: string;
    observationType: Observation['type'];
    /** Numbers and the lift name only — no free-text. The shape per
     *  observationType is the same one coachObservations builds. */
    facts: Record<string, string | number>;
    deterministicLine: string;
  }>;
}

interface EdgePhraseResponse {
  phrasings?: Record<string, string>;
}

/**
 * Bump this whenever PHRASE_SYSTEM_PROMPT (in supabase/functions/coach-recap)
 * or validatePhrasing changes its acceptance contract. The version is baked
 * into the cache key; any prior cached line is then ignored on read, so a
 * tightened prompt or validator cannot serve a stale AI line that no longer
 * meets the bar.
 *
 *   v1 — initial: ≤160-char length cap, no-invent / no-emoji / no-bang.
 *   v2 — ≤90-char hero cap; validator additionally requires a forward
 *        directive cue (no description-only lines).
 *   v3 — current: ≤130-char hero cap; exclamation allowed on milestones;
 *        rhetorical questions accepted as a forward cue. Prompt rewritten
 *        with few-shot examples and a warmer voice. userName added to the
 *        payload for light personalization.
 */
export const COACH_VOICE_PROMPT_VERSION = 3;
const CACHE_KEY_PREFIX = `coachVoiceAI:v${COACH_VOICE_PROMPT_VERSION}:`;
const DEFAULT_TIMEOUT_MS = 6000;
// The hero shows ONE line at editorial scale. Bumped from 90 → 130 (v3)
// to give the AI room for a warmer, more human line. The layout in
// CoachVoiceHero (numberOfLines={4}, minimumFontScale={0.65}) handles the
// extra length. Single source of truth with coachVoice.MAX_HERO_LINE_LEN.
const MAX_PHRASING_LEN = MAX_HERO_LINE_LEN;

// ── Allowed-number extraction ──────────────────────────────────────────
//
// The validator's core safety: every digit-sequence in the AI line must
// appear in the per-observation "allowed" set. A line like "Bench up to
// 90 kg" is rejected when facts say {from:80,to:85} — 90 is invented.
//
// The allowed set is BUILT FROM FACTS, never from the line. Domain
// constants (4 for "Week 3 of 4"; 1 and 2 for "1–2 RIR band") are added
// per observation type because they're part of the deterministic vocabulary
// the AI may legitimately quote.

/** Stringify a kg value the same way coachVoice's `kg()` helper does:
 *  one decimal max, trailing ".0" stripped. 82.5 → "82.5", 80 → "80". */
function fmtKg(n: number): string {
  if (!Number.isFinite(n)) return '';
  const r = Math.round(n * 10) / 10;
  const s = r.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Per-observation numeric allowlist as a set of canonical string forms.
 *  A number written by the AI must match one of these exactly. */
export function allowedNumbersFor(obs: Observation): Set<string> {
  const out = new Set<string>();
  const add = (...vals: (number | string | undefined)[]) => {
    for (const v of vals) {
      if (v == null) continue;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        out.add(fmtKg(v));
        out.add(String(Math.round(v)));
      } else {
        out.add(v);
      }
    }
  };

  switch (obs.type) {
    case 'lift_progression':
      if (obs.subtype === 'up') add(obs.from, obs.to, obs.span);
      else if (obs.subtype === 'stall') add(obs.weight, obs.span);
      else add(obs.days);
      break;
    case 'session_pr':
      add(obs.newKg, obs.prevKg);
      break;
    case 'consistency':
      add(obs.count, obs.metric === 'days14' ? 14 : 28);
      break;
    case 'block_position':
      // "Week N of 4" is the canonical phrasing — both N and 4 are
      // legitimate even though 4 isn't a fact per se.
      add(obs.blockWeek, 4);
      break;
    case 'effort_zone':
      // pct rounded; plus the band constants 1 and 2 from "1–2 RIR".
      add(Math.round(obs.pct * 100), 1, 2);
      break;
    case 'dialed_in':
      // Real hits/total + the "1–2 RIR" band constants. pct is bucketed
      // for the factSig but the prose uses raw counts, not a percentage.
      add(obs.hits, obs.total, 1, 2);
      break;
    case 'comeback':
      add(obs.gapDays);
      break;
    case 'briefing_fallback':
      add(obs.exerciseCount);
      break;
    case 'rest_day':
      // No numbers in the rest-day line — nothing to allow.
      break;
    case 'plan_rationale':
      // trainingDays + the constant 2 for "twice a week" / "2x" wording.
      add(obs.trainingDays, 2);
      break;
    case 'calibration':
      // No facts; allow 2 (weeks) and 14 (days) so variants can mention
      // the calibration window without tripping the digit guard.
      add(2, 14);
      break;
  }
  return out;
}

/** Extract every contiguous numeric token (incl. decimals) from a string. */
function extractNumbers(s: string): string[] {
  return s.match(/\d+(?:\.\d+)?/g) ?? [];
}

// ── Validator ──────────────────────────────────────────────────────────

const EMOJI_RE = /[☀-➿\u{1F300}-\u{1FAFF}]/u;

/**
 * Forward-directive cue set. A hero rephrase must read AND tell the user
 * what to do today — a description-only line ("Bench is moving and you've
 * hit 30 of 30 sets in the sweet spot.") drops the directive beat and
 * fails the hero contract. This is a heuristic floor, not a parser; we
 * err toward falling back to the deterministic line, which is authored
 * read+directive by construction.
 *
 * v3: a rhetorical question ("Ready to chase it?") now counts as a
 * forward cue — it's a natural coaching tool and the warmer voice
 * permits it. The question mark itself is a directive pass.
 *
 * The set covers the imperative vocabulary the coach actually uses in
 * the deterministic pools (Hit / Hold / Push / Ease / Bank / Cement / Lock /
 * Pull / Build / Find / Force / Take / Show / Run / Log / Trust / Follow /
 * Get / Add / Drop / Move / Protect / Recover / Skip / Work / Empty / Dial
 * / Stay / Bring / Make / Count / Start / Come / Train / Lighten / Reset /
 * Sharpen / Nudge / Tap / Go / Leave / Chase / Don't) plus the temporal
 * anchors "today" / "next time" that mark a forward beat. Word-boundary,
 * case-insensitive.
 */
const DIRECTIVE_CUE_RE = /\b(today|tonight|next time|don't|don’t|hit|keep|hold|push|cement|lock|bank|ease|pull|build|find|force|take|show|run|log|trust|follow|get|add|drop|move|protect|recover|skip|work|empty|dial|stay|bring|make|count|start|come|ride|tune|train|lighten|catch up|sleep|rest|reset|sharpen|nudge|tap|go|leave|chase|back off|hit them)\b/i;

/**
 * Return aiText IF it passes every safety rule, else deterministicLine.
 * Pure: same inputs → same output. Heavily unit-tested because AI output
 * itself is not deterministic — the validator is what makes the system
 * safe to ship.
 *
 * Rules (any fail → fallback):
 *   1. Non-empty after trim, ≤ MAX_PHRASING_LEN (130) chars.
 *   2. No emoji (unicode range guard — matches the coachVoice test guard).
 *   3. Every digit-sequence in aiText appears in allowedNumbersFor(obs).
 *   4. Contains at least one forward-directive cue (DIRECTIVE_CUE_RE) OR
 *      a question mark. A description-only rephrase — even if every number
 *      checks out — is rejected so the hero never reverts to the
 *      wall-of-stats voice. A rhetorical question counts as a forward cue
 *      (v3: warmer voice permits questions).
 *
 * v3 changes: exclamation marks are NO LONGER rejected. A PR line that
 * lands with a "!" is human and earned. The deterministic pools use them
 * sparingly (milestones only) and the prompt asks the model to do the same.
 */
export function validatePhrasing(
  aiText: string | null | undefined,
  obs: Observation,
  deterministicLine: string,
): string {
  if (typeof aiText !== 'string') return deterministicLine;
  const trimmed = aiText.trim();
  if (trimmed.length === 0) return deterministicLine;
  if (trimmed.length > MAX_PHRASING_LEN) return deterministicLine;
  if (EMOJI_RE.test(trimmed)) return deterministicLine;

  const allowed = allowedNumbersFor(obs);
  const found = extractNumbers(trimmed);
  for (const n of found) {
    if (!allowed.has(n)) return deterministicLine;
  }

  // Directive floor — last so a stripped-of-action rephrase still falls
  // back to the (always read+directive) deterministic line. A question
  // mark counts as a forward cue in v3 (rhetorical questions are a
  // natural coaching tool the warmer voice permits).
  if (!DIRECTIVE_CUE_RE.test(trimmed) && !trimmed.includes('?')) {
    return deterministicLine;
  }

  return trimmed;
}

// ── Edge payload builder ───────────────────────────────────────────────

/**
 * Build the closed-shape payload sent to the edge function. Exposed for
 * the "no journal fields" assertion in coachVoiceAI.test.ts — any future
 * refactor that adds a free-text channel here would have to update that
 * test, which is the speed-bump we want.
 */
export function buildEdgePayload(
  observations: Observation[],
  userName?: string,
): EdgePhrasePayload {
  const payload: EdgePhrasePayload = {
    observations: observations.map(obs => ({
      factSig: obs.factSig,
      observationType: obs.type,
      facts: factsFor(obs),
      deterministicLine: phraseObservation(obs),
    })),
  };
  if (userName && userName.trim().length > 0) {
    payload.userName = userName.trim();
  }
  return payload;
}

/** Per-observation facts — numbers and the lift name only. NEVER free-text. */
function factsFor(obs: Observation): Record<string, string | number> {
  switch (obs.type) {
    case 'lift_progression':
      if (obs.subtype === 'up') return { lift: obs.lift, from: obs.from, to: obs.to, span: obs.span };
      if (obs.subtype === 'stall') return { lift: obs.lift, weight: obs.weight, span: obs.span };
      return { lift: obs.lift, days: obs.days };
    case 'session_pr':
      return { lift: obs.lift, newKg: obs.newKg, prevKg: obs.prevKg };
    case 'consistency':
      return { count: obs.count, denom: obs.metric === 'days14' ? 14 : 28 };
    case 'block_position':
      return { blockWeek: obs.blockWeek };
    case 'effort_zone':
      return { pctInt: Math.round(obs.pct * 100), band: obs.band };
    case 'dialed_in':
      return { hits: obs.hits, total: obs.total, pctInt: Math.round(obs.pct * 100) };
    case 'comeback':
      return { gapDays: obs.gapDays };
    case 'briefing_fallback':
      return { workoutType: obs.workoutType, exerciseCount: obs.exerciseCount };
    case 'rest_day':
      return {};
    case 'plan_rationale': {
      // split is an enum label from profiles.preferred_split — closed set,
      // not free-text. Safe to send. goal/priority are also closed sets
      // (enforced by the migration CHECK + onboarding UI) so they're safe
      // to forward without sanitising as free-text.
      const out: Record<string, string | number> = { split: obs.split, trainingDays: obs.trainingDays };
      if (obs.goal) out.goal = obs.goal;
      if (obs.priority) out.priority = obs.priority;
      return out;
    }
    case 'calibration':
      return {};
  }
}

// ── Cache ──────────────────────────────────────────────────────────────

async function readCache(factSig: string): Promise<string | null> {
  try {
    // CACHE_KEY_PREFIX carries COACH_VOICE_PROMPT_VERSION — a bump there
    // immediately starts serving misses for every prior cached line. Old
    // 'coachVoiceAI:' (un-versioned) and 'coachVoiceAI:v{N-1}:' keys are
    // simply not looked up; they're inert until AsyncStorage prunes them.
    return await AsyncStorage.getItem(CACHE_KEY_PREFIX + factSig);
  } catch (e) {
    reportSilent(e, 'coachVoiceAI:readCache');
    return null;
  }
}

async function writeCache(factSig: string, text: string): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY_PREFIX + factSig, text);
  } catch (e) {
    reportSilent(e, 'coachVoiceAI:writeCache');
  }
}

// ── Network call (with timeout) ────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { __timeout: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timeout: true }>(resolve => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Rephrase a batch of observations. Returns Map<factSig, string> where the
 * value is the validated AI line on success, or the deterministic line on
 * any failure (timeout, missing key, validator reject, factSig not in
 * response). NEVER throws.
 *
 * Cache: a factSig with a cached, valid AI line is reused without calling
 * the edge function. If every observation in the batch is cached, no
 * network call happens.
 *
 * userName: optional — passed through to the edge function for light
 * personalization. The prompt instructs the model to use it occasionally.
 */
export async function phraseObservationsAI(
  observations: Observation[],
  opts?: { timeoutMs?: number; userName?: string },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (observations.length === 0) return result;

  // 1. Honor the cache first.
  const uncached: Observation[] = [];
  for (const obs of observations) {
    const det = phraseObservation(obs);
    const cached = await readCache(obs.factSig);
    if (cached) {
      // Re-validate from cache — paranoid but cheap. Protects against a
      // bad line that slipped through an earlier validator bug.
      result.set(obs.factSig, validatePhrasing(cached, obs, det));
    } else {
      uncached.push(obs);
    }
  }
  if (uncached.length === 0) return result;

  // 2. Build the payload (the no-journal invariant is enforced here).
  const payload = buildEdgePayload(uncached, opts?.userName);

  // 3. Network call — never throws to the caller.
  let phrasings: Record<string, string> = {};
  try {
    const invoke = supabase.functions.invoke('coach-recap', { body: payload });
    const raced = await withTimeout(invoke, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!(raced as { __timeout?: true }).__timeout) {
      const { data, error } = raced as { data: EdgePhraseResponse | null; error: unknown };
      if (!error && data && typeof data.phrasings === 'object' && data.phrasings) {
        phrasings = data.phrasings;
      }
    }
  } catch (e) {
    reportSilent(e, 'coachVoiceAI:invoke');
    phrasings = {};
  }

  // 4. Validate per-obs; cache valid results; fall back otherwise.
  for (const obs of uncached) {
    const det = phraseObservation(obs);
    const ai = phrasings[obs.factSig];
    const accepted = validatePhrasing(ai, obs, det);
    if (accepted !== det) {
      // Only cache the AI win — caching `det` would prevent a future
      // upgrade once the model's wording improves.
      await writeCache(obs.factSig, accepted);
    }
    result.set(obs.factSig, accepted);
  }

  return result;
}

// ── Wire-up helper ─────────────────────────────────────────────────────
//
// Both home.tsx and workout.tsx call this AFTER they've already appended
// the deterministic line via appendCoachMessageOnce. It runs the AI
// rephrase in the background and updates the stored message text by
// factSig. Fire-and-forget; the next dashboard focus picks up the upgrade.

/**
 * No-op when COACH_AI_VOICE is off or the observation list is empty.
 * Otherwise: rephrase, validate, persist via updateCoachMessageTextByFactSig.
 * Errors are swallowed; the deterministic line is what's on the card by
 * the time this runs.
 *
 * userName: optional — passed to the rephraser for light personalization.
 */
export async function runCoachVoiceUpgrade(
  userId: string,
  observations: Observation[],
  // Lazy import to avoid a circular dependency between coachVoiceAI →
  // coachMessages → coachVoiceAI in test harnesses.
  updateFn: (userId: string, factSig: string, newText: string) => Promise<void>,
  userName?: string,
): Promise<void> {
  if (!COACH_AI_VOICE) return;
  if (observations.length === 0) return;
  try {
    const phrased = await phraseObservationsAI(observations, { userName });
    for (const obs of observations) {
      const text = phrased.get(obs.factSig);
      if (!text) continue;
      const det = phraseObservation(obs);
      // Skip the write when the result equals the deterministic line that's
      // already on the card — saves an AsyncStorage round-trip per obs.
      if (text === det) continue;
      await updateFn(userId, obs.factSig, text);
    }
  } catch (e) {
    reportSilent(e, 'coachVoiceAI:upgrade');
  }
}
