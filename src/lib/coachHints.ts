// Inline coach hints — rule-based, zero LLM cost.
//
// Returns a single short sentence shown under each exercise on the
// pre-workout screen. Picks by priority:
//   1. Form cue (always relevant)
//   2. Weight suggestion (only when we have history)
//   3. First-time encouragement (no history)

export interface ExerciseInput {
  name: string;
  equipment?: string;
  primaryMuscle: string;
}

export interface HistoryEntry {
  weight_kg: number;
  date: string; // YYYY-MM-DD
}

// Per-exercise history: name → entries sorted desc by date.
export type ExerciseHistory = Record<string, HistoryEntry[]>;

const ISOLATION_KEYWORDS = [
  ' raise', ' curl', ' extension', ' fly', ' pushdown',
  ' kickback', ' pullover', ' shrug', ' crunch',
];

const HEAVY_COMPOUND_KEYWORDS = [
  'squat', 'deadlift', 'bench press', 'overhead press',
  'barbell row', 'romanian deadlift',
];

function isIsolation(name: string): boolean {
  const n = ' ' + name.toLowerCase() + ' ';
  return ISOLATION_KEYWORDS.some(k => n.includes(k));
}

function isHeavyCompound(name: string): boolean {
  const n = ' ' + name.toLowerCase() + ' ';
  return HEAVY_COMPOUND_KEYWORDS.some(k => n.includes(k));
}

function isBodyweight(eq?: string): boolean {
  return (eq ?? '').toLowerCase() === 'bodyweight';
}

// ── Form cues (per category) ──────────────────────────────────────────
// Picked deterministically so the same exercise always gets the same cue —
// no jitter on re-render.
const FORM_CUES: Record<string, string[]> = {
  // Heavy compounds — brace + range of motion
  heavy_compound: [
    'brace core, full ROM',
    'set your back, drive through the heels',
    'control the descent, explode up',
    'breath in at the top, hold through the lift',
  ],
  // Lighter compounds (press, row variants)
  compound: [
    'keep the shoulders pinned back',
    'pause briefly at full contraction',
    'no momentum — strict reps',
    'match tempo on both sides',
  ],
  // Isolation — quality over load
  isolation: [
    'quality > load · slow eccentric',
    'feel the stretch, drive the squeeze',
    'three-second descent · pause at the bottom',
    'leave the ego at the door — light and clean',
  ],
  // Bodyweight — clean reps
  bodyweight: [
    'aim for clean reps to failure on the last set',
    'pause one second at the top of every rep',
    'no swing — controlled tempo',
    'go slower than you think',
  ],
};

function deterministicPick<T>(arr: T[], seed: string): T {
  // Simple string-hash → modulo for a stable per-name pick.
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return arr[h % arr.length];
}

function categorize(ex: ExerciseInput): keyof typeof FORM_CUES {
  if (isBodyweight(ex.equipment)) return 'bodyweight';
  if (isIsolation(ex.name)) return 'isolation';
  if (isHeavyCompound(ex.name)) return 'heavy_compound';
  return 'compound';
}

/**
 * Return the short coach hint for the given exercise.
 *
 * Priority:
 *   - Has history → weight suggestion grounded in trend
 *   - No history → form/quality cue specific to category and name
 *                  (only heavy compounds get the "find a working weight"
 *                  copy; everything else gets a real form cue so the list
 *                  doesn't feel like a parrot)
 *
 * Bodyweight exercises never get weight suggestions.
 */
export function pickCoachHint(ex: ExerciseInput, history: ExerciseHistory): string {
  const category = categorize(ex);
  const entries = history[ex.name] ?? [];
  const formCue = deterministicPick(FORM_CUES[category], ex.name);

  if (category === 'bodyweight') return formCue;

  if (entries.length === 0) {
    // Only the heaviest compounds get the explicit "find a working weight"
    // hint — those are the lifts where load matters most. Everything else
    // gets a real form cue.
    if (category === 'heavy_compound') {
      return 'first time — start light, find a clean working weight';
    }
    return formCue;
  }

  const last = entries[0].weight_kg;

  if (entries.length >= 3) {
    const lastThree = entries.slice(0, 3).map(e => e.weight_kg);
    const trendUp = lastThree[0] > lastThree[2];
    const flat = lastThree.every(w => w === lastThree[0]);

    if (trendUp) return `last ${last}kg · trending up · push ${suggestNext(last, category)}kg`;
    if (flat) return `last ${last}kg · three sessions flat · try ${suggestNext(last, category)}kg`;
  }

  return `last ${last}kg · push ${suggestNext(last, category)}kg`;
}

// ── Session-level readiness narration ─────────────────────────────────
// The load engine (src/lib/loadPrescription.ts) silently pulls prescribed
// weights down when energyScore <= 2 (cancels progression bumps, lightens
// hold→backoff). The per-set coach line surfaces THAT decision after the
// user has already chosen a weight. What was missing: a session-level
// narration BEFORE the user starts, so the autoregulation reads as a
// coach decision they can see, not a silent mystery.
//
// Honest copy: the narration reflects the STANCE the coach is taking for
// the session. It deliberately doesn't claim "I changed your bench from
// 80 to 77.5" — those per-lift moves still happen at log-time. The line
// is about posture, not arithmetic.

export type ReadinessStance = 'conservative' | 'normal' | 'green';

export interface ReadinessNarration {
  /** One short coach sentence shown on the pre-screen and stored to the
   *  coach card. Plain text; no emoji, no markdown. */
  text: string;
  stance: ReadinessStance;
}

/**
 * Pure: given today's energy score (1–5), return a session-level
 * narration line + a stance, or null when the user is at baseline (3)
 * and no callout is warranted ("no nag" rule — don't surface a banner
 * just to say "everything is normal").
 *
 *   energyScore ≤ 2 → conservative (autoregulator is pulling things down)
 *   energyScore === 3 → null
 *   energyScore ≥ 4 → green (autoregulator isn't dampening — push)
 *
 * Anything outside 1–5 (defensive) maps using the same ≤2 / ≥4 buckets.
 */
export function buildReadinessNarration(energyScore: number): ReadinessNarration | null {
  if (!Number.isFinite(energyScore)) return null;
  if (energyScore <= 2) {
    return {
      stance: 'conservative',
      text: "Energy's low — I'm keeping today's loads conservative on purpose. Move clean, protect recovery.",
    };
  }
  if (energyScore >= 4) {
    return {
      stance: 'green',
      text: "Energy's good — green light. Push your top sets.",
    };
  }
  return null;
}

// ── Prescription-driven coach line ────────────────────────────────────
// One short sentence per exercise, picked from the load-prescription state
// already computed by src/lib/loadPrescription.ts.
//
// The copy branches on (rationale × energy band) so the user hears:
//   • what they actually lifted last time ({last} kg, not just {suggested});
//   • how today's energy informs the call (high → push, low → hold/back off);
//   • the same blockWeek 3/4 "chase one more rep" suffix, regardless of band.
//
// Energy bands: low = energyScore <= 2, normal = 3, high = energyScore >= 4.
// no_history has no last weight to reference; only low/normal vs high matters.
//
// The function is pure so the unit tests don't mock React/Supabase.

export type PrescriptionRationale = 'progress' | 'hold' | 'backoff' | 'no_history';
// Mirrors Prescription['cause'] in src/lib/loadPrescription.ts. Kept as a
// separate literal type because coachHints predates the prescription
// engine and was originally string-typed; widening here is the cheapest
// fix that keeps the two compatible. 'time_to_progress' is applied by the
// stall-nudge augment (applyStallNudge) — coachLineForPrescription falls
// through to the normal 'progress' copy for it, since the dedicated
// "time to add a little" line is rendered by the hero (the only place
// stallWeeks is in scope).
export type PrescriptionCause = 'failure' | 'low_energy' | 'rir' | 'time_to_progress' | 'unknown';

/** Optional exercise name for per-exercise variety. When provided,
 *  selection inside each (rationale × band × cause) pool is seeded by
 *  the name so two exercises in the same state read differently. */
export interface CoachLineContext {
  rationale: PrescriptionRationale;
  /** From the prescription. For 'hold' this equals lastWeightKg (engine
   *  repeats); for 'progress' it's the bumped-up weight; for 'backoff' it's
   *  the reduced weight. */
  suggestedWeightKg: number;
  /** What the user actually lifted last session for this exercise. The copy
   *  references this on every branch with a number, so the line feels
   *  grounded in their real history.
   *  - hold      → lastWeightKg === suggestedWeightKg.
   *  - progress  → lastWeightKg < suggestedWeightKg.
   *  - backoff   → lastWeightKg > suggestedWeightKg.
   *  Call sites without history should pass suggestedWeightKg as a safe
   *  default; the no_history branch ignores it. */
  lastWeightKg: number;
  /** From the prescription. > 0 only for genuine progress. */
  deltaPct: number;
  /** Today's energy score (1–5). Drives the band selection. */
  energyScore: number;
  /** Position within the 4-week mesocycle (1–4). Undefined when unknown — the
   *  block nudge only fires when defined and in {3, 4}. */
  blockWeek?: number;
  /** Why we landed on this rationale. Distinguishes a true failure
   *  backoff from a low-energy backoff so the line doesn't say
   *  "tough one last time" when last session was fine. Defaults to
   *  'rir' when callers don't pass it — preserves backward compatibility
   *  with the original (rationale × band)-only contract. */
  cause?: PrescriptionCause;
  /** Optional exercise name. When provided, the per-(rationale, band,
   *  cause) pool selection is seeded by the name so two exercises in
   *  the same state print different lines. Without it, every state
   *  picks pool entry 0 deterministically. */
  exerciseName?: string;
}

/** Numeric → display kg. Drops a trailing ".0" so 40 stays "40" and 82.5
 *  stays "82.5". Mirrors how the rest of the app renders kg. */
function kg(n: number): string {
  const r = Math.round(n * 10) / 10;
  const s = r.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

type EnergyBand = 'low' | 'normal' | 'high';
function bandFor(energyScore: number): EnergyBand {
  if (energyScore <= 2) return 'low';
  if (energyScore >= 4) return 'high';
  return 'normal';
}

/** djb2 — stable per-name hash for deterministic pool indexing. Same
 *  exerciseName always lands on the same pool entry; small mixing keeps
 *  similar names from clustering. */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Per-pool deterministic pick. When no exerciseName is provided the
 *  caller gets pool[0] — backward-compatible with the pre-pool contract. */
function poolPick<T>(pool: readonly T[], exerciseName?: string): T {
  if (!exerciseName) return pool[0];
  return pool[stableHash(exerciseName) % pool.length];
}

// ── Phrase pools ──────────────────────────────────────────────────────
// Three variants per (rationale × band × cause) slot so two exercises in
// the same state read differently. Every variant is honest: it references
// the same real numbers and never claims a reduction when the rounded
// display weights are equal. Equal-weight cases fall through to the
// hold pool — handled in buildPrescriptionCoachLine.

const HOLD_LOW_POOL: readonly ((last: string) => string)[] = [
  (last) => `Last time was ${last} kg, and your energy's down today. Match it if it moves clean, or drop a touch — no grinding.`,
  (last) => `${last} kg last session. Energy's low — repeat it clean, don't fight for a rep.`,
  (last) => `Hold at ${last} kg today. Low energy is no day to push — clean reps and out.`,
  // Non-load: on a low day, execution beats load. (Appended — no shipped
  // variant reordered.)
  () => `Control the way down — no bouncing, no cutting it short. Smooth beats heavy today.`,
];

// Signature gains an optional trailing `lift` (the exercise name) so the
// appended lift-named variants can interpolate it. Existing entries ignore
// the extra arg. `lift` is only ever defined when poolPick selected a
// non-zero index, which only happens when a name was supplied.
const HOLD_HIGH_POOL: readonly ((last: string, lift?: string) => string)[] = [
  (last) => `Energy's good today. You did ${last} kg last time — match it and chase an extra rep.`,
  (last) => `${last} kg again today. Energy's up — squeeze an extra clean rep out of the top set.`,
  (last) => `Holding at ${last} kg, but you've got the gas — fight for one more.`,
  // Non-load tempo cue (appended).
  (last) => `${last} kg again, but the gas is there — own the tempo and steal one more clean rep.`,
  // Lift-named (appended).
  (last, lift) => `${lift}'s ${last} kg again — energy's up, so make every rep crisp and earn an extra.`,
];

const HOLD_NORMAL_POOL: readonly ((last: string, lift?: string) => string)[] = [
  (last) => `You did ${last} kg last time. Hit that again and own every rep.`,
  (last) => `${last} kg today, same as last time. Make every rep look the same.`,
  (last) => `Holding at ${last} kg. Clean reps top to bottom.`,
  // Non-load form cues — a hold is the natural home for execution work
  // (appended; deliberately omit the weight so the coach isn't always
  // talking about load).
  () => `Same weight, but own the eccentric this time — control every rep down.`,
  () => `Match it and make every rep look identical. That's the work today.`,
  // Lift-named (appended).
  (last, lift) => `${lift} at ${last} kg again — make every rep identical.`,
];

const PROGRESS_LOW_POOL: readonly ((suggested: string, last: string) => string)[] = [
  (suggested) => `You had reps left last time, but you're low today — only go ${suggested} kg if it moves clean.`,
  (suggested, last) => `Last set was easy at ${last} kg, but energy's down — push to ${suggested} kg only if it flies up.`,
  (suggested) => `Bump to ${suggested} kg only if the first warm-up feels right; low energy is no day to grind a PR attempt.`,
];

const PROGRESS_HIGH_POOL: readonly ((suggested: string, last: string, lift?: string) => string)[] = [
  (suggested, last) => `Good energy and last set felt easy — go get ${suggested} kg today, up from ${last}.`,
  (suggested, last) => `Energy's sharp and ${last} kg had more in it — take ${suggested} kg.`,
  (suggested, last) => `Step up to ${suggested} kg today; ${last} kg looked too easy, and you're feeling it.`,
  // Lift-named (appended).
  (suggested, _last, lift) => `${lift} felt easy last time — take ${suggested} kg.`,
];

const PROGRESS_NORMAL_POOL: readonly ((suggested: string, last: string, lift?: string) => string)[] = [
  (suggested, last) => `Last set had more in the tank. You did ${last} kg — step up to ${suggested} kg.`,
  (suggested, last) => `Reps left over at ${last} kg last time. Today: ${suggested} kg.`,
  (suggested, last) => `${last} kg wasn't your ceiling — go to ${suggested} kg.`,
  // Lift-named (appended).
  (suggested, last, lift) => `${lift} had more in it at ${last} kg — step up to ${suggested} kg.`,
];

// Backoff because the LAST set hit failure (lastRir 0).
const BACKOFF_FAILURE_LOW_POOL: readonly ((suggested: string) => string)[] = [
  (suggested) => `Tough one last time and you're drained today — back off to ${suggested} kg and rebuild.`,
  (suggested) => `You ground last session out, and energy's down today. Drop to ${suggested} kg and find the groove.`,
  (suggested) => `Last session was a wall, today's a tank — ${suggested} kg, clean reps only.`,
];

const BACKOFF_FAILURE_HIGH_POOL: readonly ((suggested: string) => string)[] = [
  (suggested) => `Reset today: ${suggested} kg, sharp and clean. Build the momentum back.`,
  (suggested) => `${suggested} kg today. Last one hit the wall — use the good energy on form, not load.`,
  (suggested) => `Drop to ${suggested} kg, even though you feel sharp — recover the pattern first, push next time.`,
];

const BACKOFF_FAILURE_NORMAL_POOL: readonly ((suggested: string, lift?: string) => string)[] = [
  (suggested) => `You hit the wall last time — drop to ${suggested} kg and nail every rep.`,
  (suggested) => `Step back to ${suggested} kg after last session's grind. Build it back.`,
  (suggested) => `${suggested} kg today. Last set called for a step down — own this weight first.`,
  // Lift-named (appended) — keeps the "step back" framing so the failure
  // narrative reads honestly.
  (suggested, lift) => `${lift} called for a step back — ${suggested} kg, and nail every rep.`,
];

// Backoff because of the low-energy down-modifier. Last session was fine;
// the line must NOT say "you hit the wall" or "tough one last time".
const BACKOFF_LOWENERGY_POOL: readonly ((suggested: string, last: string) => string)[] = [
  (suggested) => `Energy's low — easing back to ${suggested} kg today, no grinding.`,
  (suggested, last) => `Last time was ${last} kg, and you're drained today — drop to ${suggested} kg and move clean.`,
  (suggested) => `Pulling the load down to ${suggested} kg for today; protect recovery and come back fresh.`,
];

const NO_HISTORY_HIGH_POOL: readonly string[] = [
  "First time on this — you've got good energy, so pick something challenging you can still control. I'll learn from it.",
  "Fresh lift, good energy. Pick a weight that's honest work for your reps — I'll calibrate from there.",
  "First time on this one and you feel sharp. Find a weight that's hard but clean; that's your real baseline.",
];

const NO_HISTORY_BASE_POOL: readonly string[] = [
  "First time on this one — pick a weight you can hit for your reps with about 1 left in the tank. I'll calibrate from there.",
  "Fresh lift. Pick something you finish with one rep to spare. That's the data I need.",
  "New movement — find a weight that lets you finish clean with a rep left over. I'll meet you there next time.",
];

/** Build the per-exercise coach line for one prescription state. Always
 *  returns a non-empty, specific sentence — never a generic fallback.
 *
 *  Equal-weight guard applies to ALL branches where a numeric move would
 *  be claimed: if the rounded display weights of suggested and last are
 *  equal, the line falls back to the hold copy on the matching band so
 *  we never print "back off to 80 kg" when last was already 80. */
export function buildPrescriptionCoachLine(ctx: CoachLineContext): string {
  const { rationale, suggestedWeightKg, lastWeightKg, energyScore, blockWeek, cause = 'rir', exerciseName } = ctx;
  const band = bandFor(energyScore);
  const suggested = kg(suggestedWeightKg);
  const last = kg(lastWeightKg);
  const equalDisplay = suggested === last;

  const holdLine = (): string => {
    if (band === 'low') return poolPick(HOLD_LOW_POOL, exerciseName)(last);
    if (band === 'high') return poolPick(HOLD_HIGH_POOL, exerciseName)(last, exerciseName);
    return poolPick(HOLD_NORMAL_POOL, exerciseName)(last, exerciseName);
  };

  let line: string;
  if (rationale === 'no_history') {
    line = band === 'high'
      ? poolPick(NO_HISTORY_HIGH_POOL, exerciseName)
      : poolPick(NO_HISTORY_BASE_POOL, exerciseName);
  } else if (rationale === 'hold') {
    line = holdLine();
  } else if (rationale === 'progress') {
    // Equal-weight guard — sub-display-resolution bumps round to the
    // same kg() string. "Up from 20" is nonsense; use hold copy.
    if (equalDisplay) {
      line = holdLine();
    } else if (band === 'low') {
      line = poolPick(PROGRESS_LOW_POOL, exerciseName)(suggested, last);
    } else if (band === 'high') {
      line = poolPick(PROGRESS_HIGH_POOL, exerciseName)(suggested, last, exerciseName);
    } else {
      line = poolPick(PROGRESS_NORMAL_POOL, exerciseName)(suggested, last, exerciseName);
    }
  } else {
    // backoff. Equal-weight guard applies here too — a −5% bump that
    // rounds to the same plate is NOT a reduction; tell the truth.
    if (equalDisplay) {
      line = holdLine();
    } else if (cause === 'low_energy') {
      // Low-energy backoff: last session was fine. Never claim "tough
      // one last time" or "you hit the wall" — use energy-framed copy.
      line = poolPick(BACKOFF_LOWENERGY_POOL, exerciseName)(suggested, last);
    } else if (band === 'low') {
      line = poolPick(BACKOFF_FAILURE_LOW_POOL, exerciseName)(suggested);
    } else if (band === 'high') {
      line = poolPick(BACKOFF_FAILURE_HIGH_POOL, exerciseName)(suggested);
    } else {
      line = poolPick(BACKOFF_FAILURE_NORMAL_POOL, exerciseName)(suggested, exerciseName);
    }
  }

  if (blockWeek === 3 || blockWeek === 4) {
    line += ` Week ${blockWeek} on this lift — chase one more rep than last time.`;
  }

  return line;
}

/** Structural subset of loadPrescription's Prescription — what the coach
 *  line actually needs. Kept local so coachHints doesn't import the
 *  prescription engine. */
export interface PrescriptionForLine {
  rationale: PrescriptionRationale;
  suggestedWeightKg: number;
  deltaPct: number;
  cause: PrescriptionCause;
}

/** Map a prescription — or its absence — to the coach line. Shared by the
 *  pre-screen exercise list and the active-set weight popup so both
 *  surfaces speak with one voice. `rx === undefined` means no logged
 *  history for this lift (e.g. a swapped-in exercise): treated as
 *  no_history so the user gets the calibration line instead of a blank.
 *  `lastWeightKg` falls back to the suggested weight for the rare
 *  mid-state where a prescription exists but lastWeights is still cold —
 *  keeps the kg slot in the copy non-empty. */
export function coachLineForPrescription(
  rx: PrescriptionForLine | undefined,
  opts: {
    exerciseName: string;
    lastWeightKg?: number;
    energyScore: number;
    blockWeek?: number;
  }
): string {
  const { exerciseName, lastWeightKg, energyScore, blockWeek } = opts;
  if (!rx) {
    return buildPrescriptionCoachLine({
      rationale: 'no_history',
      suggestedWeightKg: 0,
      lastWeightKg: 0,
      deltaPct: 0,
      energyScore,
      blockWeek,
      cause: 'unknown',
      exerciseName,
    });
  }
  return buildPrescriptionCoachLine({
    rationale: rx.rationale,
    suggestedWeightKg: rx.suggestedWeightKg,
    lastWeightKg: lastWeightKg ?? rx.suggestedWeightKg,
    deltaPct: rx.deltaPct,
    energyScore,
    blockWeek,
    cause: rx.cause,
    exerciseName,
  });
}

// ── Energy-driven workout reduction ───────────────────────────────────
// The energy system is meaningful: low energy actually changes the session.
// User can still override every change manually (swap, +set, restore).
//
//   1 (DRAINED): cut 1 set off everything (min 1) + drop the last isolation
//                if there is one. Banner explains what changed.
//   2 (LOW)    : cut 1 set off everything (min 1). All exercises remain.
//   3, 4, 5    : original plan, no changes.

export interface ReductionResult<T> {
  exercises: T[];
  setsCut: number;                 // energy 1–2: total sets removed across exercises
  exerciseDropped: string | null;  // energy 1: trailing isolation removed, if any
  setsAdded: number;               // energy 5: extra sets added to leading compound(s)
  repBump: number;                 // energy 4: per-exercise rep target bump (constant)
}

/**
 * Bump a reps value by `bump`. Handles "8-12" ranges, single numbers, and
 * numeric inputs. Unrecognized formats (e.g. "AMRAP") are returned unchanged.
 */
function bumpReps(
  reps: string | number | undefined,
  bump: number,
): string | number | undefined {
  if (reps == null) return reps;
  if (typeof reps === 'number') return reps + bump;
  const range = reps.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (range) return `${parseInt(range[1], 10) + bump}-${parseInt(range[2], 10) + bump}`;
  const single = reps.match(/^\s*(\d+)\s*$/);
  if (single) return String(parseInt(single[1], 10) + bump);
  return reps;
}

export function applyEnergyEffect<
  T extends { name: string; sets: number; equipment?: string; reps?: string | number },
>(
  exercises: T[],
  energyScore: number,
): ReductionResult<T> {
  // Energy 3 — baseline, no changes.
  if (energyScore === 3) {
    return { exercises, setsCut: 0, exerciseDropped: null, setsAdded: 0, repBump: 0 };
  }

  // Energy 5 — sharp upside. Add one set to up to 2 of the leading exercises
  // (plan ordering puts the heaviest compounds first; capped at +2 sets total
  // so a single great day can't inflate volume catastrophically).
  if (energyScore === 5) {
    let setsAdded = 0;
    const working = exercises.map((e, i) => {
      if (i < 2 && setsAdded < 2) {
        setsAdded++;
        return { ...e, sets: e.sets + 1 };
      }
      return { ...e };
    });
    return { exercises: working, setsCut: 0, exerciseDropped: null, setsAdded, repBump: 0 };
  }

  // Energy 4 — bump rep target by 2 across the board, leave sets alone. The
  // load engine still gates the weight; this is strictly a volume bump in the
  // rep dimension.
  if (energyScore === 4) {
    const bump = 2;
    const working = exercises.map(e => ({
      ...e,
      reps: bumpReps(e.reps, bump) as T['reps'],
    }));
    return { exercises: working, setsCut: 0, exerciseDropped: null, setsAdded: 0, repBump: bump };
  }

  // Energy 1–2 — original low-energy reduction.
  let working = exercises.map(e => ({ ...e }));
  let exerciseDropped: string | null = null;

  // Energy 1: drop the trailing isolation if one exists.
  if (energyScore === 1) {
    for (let i = working.length - 1; i >= 0; i--) {
      const ex = working[i];
      if (isIsolation(ex.name) && !isBodyweight(ex.equipment)) {
        exerciseDropped = ex.name;
        working = working.filter((_, idx) => idx !== i);
        break;
      }
    }
  }

  // Energy 1–2: shave one set off everything, floor at 1.
  let setsCut = 0;
  working = working.map(ex => {
    if (ex.sets > 1) {
      setsCut++;
      return { ...ex, sets: ex.sets - 1 };
    }
    return ex;
  });

  return { exercises: working, setsCut, exerciseDropped, setsAdded: 0, repBump: 0 };
}

/**
 * Suggest the next progressive-overload weight.
 *   - Heavy compound: +2.5 kg (standard small-plate jump for lower body)
 *   - Compound: +2.5 kg
 *   - Isolation: +1.25 kg if dumbbell, else +2.5
 *
 * Returns the suggested weight, rounded to nearest 2.5.
 */
function suggestNext(last: number, category: keyof typeof FORM_CUES): number {
  const step = category === 'isolation' ? 1.25 : 2.5;
  const raw = last + step;
  return Math.round(raw / 2.5) * 2.5;
}

// ── Banner picker ─────────────────────────────────────────────────────

export type BannerKind =
  | { kind: 'first_week' }
  | { kind: 'energy_high'; addSetTarget?: string; setsAdded: number }
  | { kind: 'energy_low'; reduction: { setsCut: number; exerciseDropped: string | null } }
  | { kind: 'energy_steady'; tone: 'solid' | 'sharp'; line: string; repBump: number }
  | { kind: 'none' };

/**
 * Build the "low energy" banner sentence from the reduction metadata.
 * Co-located here so the JSX doesn't need an inline IIFE.
 */
export function formatLowEnergyBanner(setsCut: number, exerciseDropped: string | null): string {
  const parts: string[] = [];
  if (setsCut > 0) parts.push(`cut ${setsCut} set${setsCut > 1 ? 's' : ''}`);
  if (exerciseDropped) parts.push(`dropped ${exerciseDropped}`);
  if (parts.length === 0) return 'Tap ⇄ to swap any heavy lift below for something lighter.';
  return `Coach ${parts.join(' and ')}. Tap ⇄ to swap anything else.`;
}

interface BannerArgs {
  daysSinceSignup: number;
  energyScore: number;
  exercises: ExerciseInput[];
  /** YYYY-MM-DD — used to pick a deterministic line so the same day always
   *  shows the same hint (no jitter on re-render). */
  todayStr?: string;
  /** What the energy reduction did (for the low-energy banner copy). */
  reduction?: { setsCut: number; exerciseDropped: string | null };
  /** What the energy boost did (energy 4 / 5 path). Sourced from applyEnergyEffect. */
  boost?: { setsAdded: number; repBump: number };
}

// Energy 3 = "Solid baseline" — practical reminders, no hype.
const SOLID_LINES = [
  'Steady is the win. Just execute the plan.',
  'Form before load. The reps you take today set tomorrow\'s ceiling.',
  'Showing up is the work. The rest is bookkeeping.',
  'Three-second eccentric on every working set. You\'ll feel it.',
  'Hydrate between sets. Half a liter today, you\'ll thank yourself tomorrow.',
  'Match tempo on both sides. The weak side decides.',
];

// Energy 4 = "Sharp" — controlled aggression, not recklessness.
const SHARP_LINES = [
  "Sharp today. Don't leave reps on the floor.",
  'Good day to add one rep on your top set. Don\'t fish for a PR — earn it.',
  'Push to RPE 8, not 10. Leave one in the tank for next session.',
  'Sharp doesn\'t mean heavy. Hit clean reps at the planned weight first.',
  'Warm-up properly. Strong start, longer career.',
  'You feel good. Use it to nail tempo, not chase a number.',
];

function pickDailyLine(pool: string[], seedDate: string, energyScore: number): string {
  // Stable per (day, energy); changes if user updates energy same day.
  return deterministicPick(pool, `${seedDate}:${energyScore}`);
}

export function pickBanner({ daysSinceSignup, energyScore, exercises, todayStr, reduction, boost }: BannerArgs): BannerKind {
  // First week always wins — overrides energy banners.
  if (daysSinceSignup >= 0 && daysSinceSignup < 7) {
    return { kind: 'first_week' };
  }
  if (energyScore === 5) {
    const target =
      exercises.find(e => isHeavyCompound(e.name)) ??
      exercises.find(e => !isIsolation(e.name) && !isBodyweight(e.equipment)) ??
      exercises[0];
    return {
      kind: 'energy_high',
      addSetTarget: target?.name,
      setsAdded: boost?.setsAdded ?? 0,
    };
  }
  if (energyScore <= 2) {
    return {
      kind: 'energy_low',
      reduction: reduction ?? { setsCut: 0, exerciseDropped: null },
    };
  }
  // Energy 3 or 4 — rotating coaching one-liner.
  const seed = todayStr ?? new Date().toISOString().slice(0, 10);
  if (energyScore === 4) {
    return {
      kind: 'energy_steady',
      tone: 'sharp',
      line: pickDailyLine(SHARP_LINES, seed, 4),
      repBump: boost?.repBump ?? 0,
    };
  }
  // Default: energy 3
  return {
    kind: 'energy_steady',
    tone: 'solid',
    line: pickDailyLine(SOLID_LINES, seed, 3),
    repBump: 0,
  };
}
