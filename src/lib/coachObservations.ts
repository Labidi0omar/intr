// The BRAIN of the coach memory / continuity engine.
//
// Pure, deterministic, no AsyncStorage / supabase / Date.now / React. Every
// input is passed in explicitly so jest can drive the corners. This module
// answers "WHAT did the coach notice?" — structured facts only, NEVER prose.
// The MOUTH (src/lib/coachVoice.ts) maps Observation → string; the dedup
// guard lives at the message store (appendCoachMessageOnce, keyed on the
// factSig defined here).
//
// Architectural rule: keep this file free of any phrasing. A new template
// in coachVoice should never require a change here, and a new observation
// kind here should land with one Observation -> string switch case in
// coachVoice — nothing else.

// ── Observation discriminated union ────────────────────────────────────
//
// Every observation carries:
//   id        – stable identity (e.g. "lift_progression:Bench"), used for
//               UI keys / debugging; not part of the dedup primitive.
//   factSig   – short canonical encoding of the HEADLINE NUMBERS. Two
//               observations with the same factSig are the SAME FACT — the
//               coach must not re-speak them. When the underlying number
//               advances, factSig advances, and the line speaks again.
//   salience  – 0..1. Drives the selector ranking; salience >= 0.8 is the
//               threshold to earn a second slot on a focus.
//
//               Current ordering — re-ranked to put VALUABLE READS first.
//               The dashboard hero is "read + directive": where the user is
//               + what to do today. Pure description (a bare PR / "new high")
//               must NEVER win on its own — those are demoted below the
//               state-aware reads. Highest → lowest:
//
//                 PROTECTIVE / BACK-OFF (the "ease up" reads):
//                   0.96  grinding         (SYNTHESIS — stall/decline + low energy)
//                   0.95  block_position:4 (recovery week earned)
//
//                 GREEN-LIGHT (the "you've got room" reads):
//                   0.9   pushing_hard     (SYNTHESIS — progression + fatigue
//                                           → bank the win, ease the volume)
//                   0.88  back_on_track    (SYNTHESIS — comeback + progression)
//
//                 TACTICAL STALL (the "one more rep before adding weight" read):
//                   0.85  lift_progression:stall
//
//                 CONSISTENCY:
//                   0.75  consistency
//
//                 MESOCYCLE FRAMING:
//                   0.7   block_position:3 (last hard build before back-off)
//
//                 RETURN:
//                   0.65  comeback        (whole-training; was 1.0)
//
//                 BARE DESCRIPTION (lowest — must still carry a directive):
//                   0.62  session_pr       (was 0.97 — demoted; today's PR
//                                           only leads when nothing else
//                                           qualifies, and the phrasing
//                                           always includes "hold/cement/
//                                           don't chase another today")
//                   0.6   lift_progression:comeback / dialed_in / calibration
//                   0.55  lift_progression:up / plan_rationale
//                   0.5   effort_zone
//                   0.1   briefing_fallback / rest_day
//
//               Composites also SUBSUME their component single-facts in the
//               selector (see selectTopObservations) — so the coach speaks the
//               connected read, never the part alongside the whole.
//   eventDate – YYYY-MM-DD of the underlying signal (last session date,
//               today, etc.). Tie-breaker for equal salience.
//   facts     – the structured numbers the phraser will compose into a
//               sentence. No prose.

type BaseObs = {
  id: string;
  factSig: string;
  salience: number;
  eventDate: string;
};

export type LiftProgressionObservation =
  | (BaseObs & {
      type: 'lift_progression';
      subtype: 'up';
      lift: string;
      from: number;
      to: number;
      /** Run length: how many consecutive sessions the top weight has risen
       *  (the rising tail, oldest-first). 3 = "climbed three sessions straight". */
      span: number;
      /** True when `to` is the highest top weight across the WHOLE provided
       *  window (a new high), not just higher than the prior session. Lets the
       *  MOUTH say "new best" instead of plain "up". Optional so legacy/test
       *  fixtures without it deserialize as a non-high up. */
      isAllTimeHigh?: boolean;
    })
  | (BaseObs & {
      type: 'lift_progression';
      subtype: 'stall';
      lift: string;
      weight: number;
      span: number;
    })
  | (BaseObs & {
      type: 'lift_progression';
      subtype: 'comeback';
      lift: string;
      days: number;
    });

export type SessionPrObservation = BaseObs & {
  type: 'session_pr';
  lift: string;
  newKg: number;
  prevKg: number;
};

export type ConsistencyObservation = BaseObs & {
  type: 'consistency';
  metric: 'days14' | 'days28';
  count: number;
};

export type BlockPositionObservation = BaseObs & {
  type: 'block_position';
  /** In-block week position. Widened from 3|4 → 1|2|3|4 in v8 to carry the
   *  volume-ramp phase for the muscle lane (wk1 = intro / wk2 = build /
   *  wk3 = peak / wk4 = deload). Wk1 and wk2 only fire when goal === 'muscle'
   *  — the strength lane has no volume ramp to narrate, so its BLOCK
   *  observations still start at wk3 (framing) and wk4 (deload earned). */
  blockWeek: 1 | 2 | 3 | 4;
  /** Goal lane at observation time. Optional so pre-v8 stored observations
   *  and callers that don't pass it still deserialize; the phraser reads it
   *  to pick the right pool (muscle ramp voice on wk1/2, existing pools
   *  otherwise). */
  goal?: 'strength' | 'muscle' | 'general' | null;
};

export type EffortZoneObservation = BaseObs & {
  type: 'effort_zone';
  band: 'high' | 'low';
  pct: number;
};

/** "The engine is dialed in to you" trust message. Fires when the user
 *  has logged enough rated sets (≥ 8) AND the autoregulator's hit rate
 *  in the 1–2 RIR target zone is at or above ~70%. Reads from the same
 *  (hits, total) the dashboard's effortZone state already holds, so no
 *  new fetch is needed.
 *
 *  Honest by construction: never fires when the hit rate is low — that
 *  case still belongs to buildEffortZone's "drifting easy" line or to
 *  the cold-start calibration message. */
export type DialedInObservation = BaseObs & {
  type: 'dialed_in';
  hits: number;
  total: number;
  pct: number;
};

export type ComebackObservation = BaseObs & {
  type: 'comeback';
  gapDays: number;
};

export type BriefingFallbackObservation = BaseObs & {
  type: 'briefing_fallback';
  workoutType: string;
  exerciseCount: number;
};

/** Rest-day baseline. The training-day counterpart of briefing_fallback:
 *  fires only on a rest day (no planned training today) so the coach card
 *  doesn't keep showing yesterday's "{type} day — N exercises" briefing.
 *  Like the briefing fallback it's a last-resort filler (salience 0.1,
 *  surfaced only when no real signal wins) — a PR/streak/deload on a rest
 *  day still leads. factSig is per-day so a fresh rest message supersedes
 *  the prior day's briefing in the store rather than being deduped. */
export type RestDayObservation = BaseObs & {
  type: 'rest_day';
};

/** Cold-start "why this plan" line — explains the chosen split in terms of
 *  the user's training_days, optionally personalised on the onboarding-time
 *  goal + priority. Fires only while ramping (totalCompleted < 8) so it
 *  auto-retires the moment real signal appears, both by the guard here and
 *  by salience ordering.
 *
 *  factSig is per-split AND per-(goal,priority) so a user who edits any of
 *  those re-hears the rationale tuned to the new combination instead of
 *  being permanently deduped on the prior split-only sig.
 *
 *  goal / priority are optional (legacy rows pre-date them, and onboarding
 *  itself allows priority to stay null). When absent the phraser falls back
 *  to the existing split-only line. */
export type PlanRationaleGoal = 'strength' | 'muscle' | 'general';
export type PlanRationaleObservation = BaseObs & {
  type: 'plan_rationale';
  split: string;
  trainingDays: number;
  /** Onboarding goal. Null/undefined means "we don't know" — phraser uses
   *  the generic split line. */
  goal?: PlanRationaleGoal | null;
  /** Onboarding priority — one of the muscle buckets ('chest','back',
   *  'shoulders','arms','legs') or a key compound ('bench','squat',
   *  'deadlift'). Null = no preference. */
  priority?: string | null;
};

/** Cold-start "I'm learning you" line. Bare `'calibration'` factSig — once
 *  the memory guard has logged it, it's a permanent no-op for this user,
 *  which IS the once-in-the-window semantics. Auto-retires past the
 *  2-week / 6-session guard too. */
export type CalibrationObservation = BaseObs & {
  type: 'calibration';
};

export type Observation =
  | LiftProgressionObservation
  | SessionPrObservation
  | ConsistencyObservation
  | BlockPositionObservation
  | EffortZoneObservation
  | DialedInObservation
  | ComebackObservation
  | BriefingFallbackObservation
  | RestDayObservation
  | PlanRationaleObservation
  | CalibrationObservation;

// ── Composite (synthesis) observations ─────────────────────────────────
//
// Composites are where coaching JUDGMENT lives: they fire when several
// single-fact signals CO-OCCUR and replace the disconnected parts with one
// connected read ("you're pushing hard" instead of "bench up" + "low energy
// again"). They are a SEPARATE union from Observation on purpose — the
// AI-rephrase layer (coachVoiceAI) only ever handles deterministic single
// facts, never the synthesis, so it stays untouched. The selector and the
// MOUTH operate on CoachObservation (= Observation | CompositeObservation).
//
// Each carries `subsumes`: the ids of the single observations it stands in
// for, so selectTopObservations can drop those parts and speak only the
// composite. Salience sits above the strong single facts but below a PR /
// block-position so a deload signal still leads.

/** Progression on key lifts WHILE fatigue is repeating (≥2 low-energy
 *  sessions and/or ≥2 RIR misses). "Bank the win and protect recovery." */
export type PushingHardObservation = BaseObs & {
  type: 'pushing_hard';
  /** The top progressing lift, for a specific callout. */
  lift: string;
  /** Which fatigue signal(s) co-occurred. */
  fatigue: 'low_energy' | 'rir_misses' | 'both';
  /** Component observation ids this composite replaces (the up facts). */
  subsumes: readonly string[];
};

/** A stall or decline WHILE energy is repeatedly low — the slog. Acknowledge
 *  it and point at recovery. */
export type GrindingObservation = BaseObs & {
  type: 'grinding';
  /** The stalled/declining lift named in the line. */
  lift: string;
  strain: 'stall' | 'decline';
  /** Component observation ids replaced (the stall facts; declines have none). */
  subsumes: readonly string[];
};

/** A recent comeback followed by fresh progression — the return is working. */
export type BackOnTrackObservation = BaseObs & {
  type: 'back_on_track';
  lift: string;
  /** Component ids replaced (the comeback + up facts). */
  subsumes: readonly string[];
};

export type CompositeObservation =
  | PushingHardObservation
  | GrindingObservation
  | BackOnTrackObservation;

/** The full fact set the selector + MOUTH operate on. coachVoiceAI stays on
 *  the narrower `Observation` (deterministic single facts only). */
export type CoachObservation = Observation | CompositeObservation;

/** True for the synthesis observations. Used by the selector (subsumption)
 *  and by the dashboard to keep composites out of the AI-rephrase batch. */
export function isCompositeObservation(o: CoachObservation): o is CompositeObservation {
  return o.type === 'pushing_hard' || o.type === 'grinding' || o.type === 'back_on_track';
}

// ── Input shape ────────────────────────────────────────────────────────

export interface LiftSessionTop {
  /** Top numeric weight from this session, in kg. */
  topKg: number;
  /** YYYY-MM-DD of the session. */
  date: string;
}

export interface ObservationsInput {
  /** YYYY-MM-DD. Anchor for "today" decisions. */
  todayIso: string;
  /** Per-lift session top weights, **oldest first**, recovery rows already
   *  excluded. Only lifts with at least one session in the input window
   *  should appear; absent keys mean "no recent data". */
  liftSessions: Record<string, LiftSessionTop[]>;
  /** Today's PRs detected by the finish flow. Only populated on the
   *  workout-finish path; the dashboard focus passes [] (or omits). */
  sessionPrs?: Array<{ lift: string; newKg: number; prevKg: number }>;
  /** Distinct training days in the last 14 / 28 calendar days. */
  trainedDays14: number;
  trainedDays28: number;
  /** Mesocycle position (1..4) for the current week. null when unknown. */
  blockWeek: number | null;
  /** Effort-zone counts from src/utils/dashboardStats — hits in 1–2 RIR
   *  over the recent rated-set window, plus the window total. */
  effortZone: { hits: number; total: number };
  /** Missed scheduled training days (NOT raw calendar days) over the last
   *  ~14d. Caller approximates this as max(0, expectedSessions − completed).
   *  Passing 0 disables the comeback observation. */
  gapDays: number;
  /** Today's PlanDay workoutType + exercise count. A real training day has a
   *  non-empty workoutType and ≥1 exercise → briefing_fallback. Null/empty or
   *  'Rest' with 0 exercises → rest day → rest_day observation instead (so the
   *  card doesn't go stale on the prior training briefing). */
  todayWorkoutType: string | null;
  todayExerciseCount: number;
  /** profiles.preferred_split — enum label like "full_body" / "upper_lower"
   *  / "ppl" / "bro_split". Drives the plan-rationale cold-start. */
  split: string | null;
  /** profiles.training_days. Used by plan_rationale to ground the "{N} days,
   *  so push/pull/legs" framing in a real number. */
  trainingDays: number | null;
  /** profiles.goal — 'strength' | 'muscle' | 'general' | null. When set the
   *  cold-start plan_rationale uses a goal-specific line instead of the
   *  generic split copy. Null when the legacy row pre-dates onboarding goal
   *  capture or the user re-onboarded without one. */
  goal?: PlanRationaleGoal | null;
  /** profiles.priority — one of the muscle buckets / key compounds the
   *  onboarding flow allows. Wins over goal in the rationale phrasing when
   *  present (the user named a specific thing they want to push). */
  priority?: string | null;
  /** Days since the user's earliest completed session. NULL means brand
   *  new — no completed sessions yet. Builders read null as "first session
   *  hasn't happened" (collapses to "no baseline" in computeGapDays and
   *  unlocks the calibration observation). */
  firstSessionDaysAgo: number | null;
  /** Total completed sessions the caller observed. Cold-start guards key
   *  off this: plan_rationale fires while <8, calibration while <6. */
  totalCompleted: number;
  /** Repeated-fatigue signals for the composite (synthesis) observations —
   *  the SAME numbers Training Status reads, so the brain stays one coherent
   *  fact set. lowEnergySessions = recent sessions with a low pre-workout
   *  energy read; rirMissSets = recent rated sets outside the 1–2 RIR target
   *  zone. Both optional (default 0) so callers that don't pass them simply
   *  never trigger a composite. */
  lowEnergySessions?: number;
  rirMissSets?: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────

/** Truncate a kg value to one decimal, then strip trailing ".0" so 80.0
 *  becomes "80" and 82.5 stays "82.5". Used only to build factSig strings —
 *  prose formatting lives in coachVoice. */
function fmtFactKg(n: number): string {
  const r = Math.round(n * 10) / 10;
  const s = r.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Days between two YYYY-MM-DD strings (b − a). Never negative. Used to
 *  compute "back after layoff" spans. */
function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || pa.some(isNaN) || pb.some(isNaN)) return 0;
  const da = new Date(pa[0], pa[1] - 1, pa[2]);
  const db = new Date(pb[0], pb[1] - 1, pb[2]);
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / 86400000));
}

// ── Builders ───────────────────────────────────────────────────────────
// Each builder is pure and returns Observation | null. deriveObservations
// runs them all and concatenates — the selector picks the headline below.

/**
 * Per-lift progression read. Scans the most recent run of sessions for one
 * lift and surfaces the dominant state:
 *
 *   up      – last N≥2 sessions strictly increasing in top weight.
 *             factSig: `up-${to}`         salience 0.9
 *   stall   – last N≥2 sessions at the SAME top weight.
 *             factSig: `stall-${w}-${N}`  salience 0.8
 *   comeback – first log in 14+ days (vs today).
 *             factSig: `comeback-${days}` salience 0.7
 *
 * Returns at most ONE observation per lift — "up" beats "stall" beats
 * "comeback" via salience.
 */
export function buildLiftProgression(
  lift: string,
  sessionsOldestFirst: LiftSessionTop[],
  todayIso: string,
): LiftProgressionObservation | null {
  if (!lift || !sessionsOldestFirst || sessionsOldestFirst.length === 0) return null;

  const last = sessionsOldestFirst[sessionsOldestFirst.length - 1];
  const daysSinceLast = daysBetween(last.date, todayIso);

  // Dormant lift — last touched 14+ days ago. Up/stall on stale data is
  // not actionable; the comeback observation needs a fresh session to anchor.
  // Return null and let the caller stay silent on this lift.
  if (daysSinceLast >= 14) return null;

  // "comeback" — most recent session is fresh AND came after a 14+ day
  // gap from the previous session. This is the "user returned to this
  // lift after a layoff" signal.
  if (sessionsOldestFirst.length >= 2) {
    const prev = sessionsOldestFirst[sessionsOldestFirst.length - 2];
    const layoff = daysBetween(prev.date, last.date);
    if (layoff >= 14) {
      return {
        type: 'lift_progression',
        subtype: 'comeback',
        id: `lift_progression:${lift}`,
        factSig: `comeback-${layoff}`,
        salience: 0.6,
        eventDate: last.date,
        lift,
        days: layoff,
      };
    }
  }

  // Walk backwards from the most recent session to find the longest tail
  // that is either strictly increasing (up) or all-equal (stall).
  let upRun = 1;
  for (let i = sessionsOldestFirst.length - 1; i > 0; i--) {
    if (sessionsOldestFirst[i].topKg > sessionsOldestFirst[i - 1].topKg) upRun++;
    else break;
  }
  let stallRun = 1;
  for (let i = sessionsOldestFirst.length - 1; i > 0; i--) {
    if (sessionsOldestFirst[i].topKg === sessionsOldestFirst[i - 1].topKg) stallRun++;
    else break;
  }

  // "up" wins if it's at least 2 sessions long.
  if (upRun >= 2) {
    const tailStart = sessionsOldestFirst[sessionsOldestFirst.length - upRun];
    // New-high check over the WHOLE provided window: is the latest top the
    // highest weight on record here? (Not just higher than the prior session.)
    let maxAll = sessionsOldestFirst[0].topKg;
    for (const s of sessionsOldestFirst) if (s.topKg > maxAll) maxAll = s.topKg;
    const isAllTimeHigh = last.topKg >= maxAll;
    return {
      type: 'lift_progression',
      subtype: 'up',
      id: `lift_progression:${lift}`,
      factSig: `up-${fmtFactKg(last.topKg)}`,
      // Demoted: a bare "lift up" is description, not a coaching read.
      // The hero-eligible reads above (protective/green-light/stall/
      // consistency/mesocycle) lead. The phraser still attaches a
      // forward directive ("clean reps today, no max attempts").
      salience: 0.55,
      eventDate: last.date,
      lift,
      from: tailStart.topKg,
      to: last.topKg,
      span: upRun,
      isAllTimeHigh,
    };
  }

  // "stall" — at least 2 sessions at the same weight.
  if (stallRun >= 2) {
    return {
      type: 'lift_progression',
      subtype: 'stall',
      id: `lift_progression:${lift}`,
      factSig: `stall-${fmtFactKg(last.topKg)}-${stallRun}`,
      // Tactical: stalls earn a directive ("one more rep before you add
      // weight") — that's an actionable coaching call, so the stall sits
      // above consistency/comeback/bare PR.
      salience: 0.85,
      eventDate: last.date,
      lift,
      weight: last.topKg,
      span: stallRun,
    };
  }

  return null;
}

/**
 * Today's PR. Returns null when newKg ≤ prevKg, or when prevKg is missing
 * (first-time lift — never a PR). Salience 0.9.
 */
export function buildSessionPr(
  lift: string,
  newKg: number,
  prevKg: number,
  todayIso: string,
): SessionPrObservation | null {
  if (!lift || !lift.trim()) return null;
  if (!Number.isFinite(newKg) || !Number.isFinite(prevKg)) return null;
  if (newKg <= prevKg) return null;
  return {
    type: 'session_pr',
    id: `session_pr:${lift}`,
    factSig: `pr-${fmtFactKg(newKg)}`,
    // Demoted (was 0.97). A bare PR is DESCRIPTION — what already
    // happened. The hero needs read + directive: where you are AND
    // what to do today. Protective/green-light/stall reads lead;
    // PR only wins when nothing else qualifies, and the phrasing
    // always attaches a forward directive ("bank it; the next jump
    // waits", "cement the form; don't chase another today").
    salience: 0.62,
    eventDate: todayIso,
    lift,
    newKg,
    prevKg,
  };
}

/**
 * Consistency milestone. Fires when the user trained ≥12 of the last 14
 * days OR ≥20 of the last 28. Picks the higher-density window. factSig
 * advances day-by-day as the count changes, so a single "12/14" line
 * doesn't echo for a week.
 */
export function buildConsistency(
  trainedDays14: number,
  trainedDays28: number,
  todayIso: string,
): ConsistencyObservation | null {
  const d14 = Math.max(0, Math.floor(trainedDays14));
  const d28 = Math.max(0, Math.floor(trainedDays28));
  // Prefer the tighter window when both hit; it's the more recent signal.
  if (d14 >= 12) {
    return {
      type: 'consistency',
      id: 'consistency:days14',
      factSig: `consist-${d14}of14`,
      salience: 0.75,
      eventDate: todayIso,
      metric: 'days14',
      count: d14,
    };
  }
  if (d28 >= 20) {
    return {
      type: 'consistency',
      id: 'consistency:days28',
      factSig: `consist-${d28}of28`,
      salience: 0.75,
      eventDate: todayIso,
      metric: 'days28',
      count: d28,
    };
  }
  return null;
}

/**
 * Block position — narrates where the user is in the 4-week mesocycle.
 *
 * Pre-v8 contract (goal absent or not 'muscle'): only weeks 3 ("last build
 * before deload") and 4 ("deload earned") earn a line. Weeks 1–2 are silent
 * — no volume ramp to speak to on the strength / general lanes.
 *
 * v8 (goal === 'muscle'): weeks 1–4 all earn a line, so the coach can
 * narrate the volume ramp (wk1 intro → wk2 build → wk3 peak → wk4 deload).
 * The intro / build reads have low salience so they only surface when
 * nothing more actionable qualifies.
 *
 * Salience tiers:
 *   wk4 → 0.95  protective (recovery week earned) — unchanged
 *   wk3 → 0.7   mesocycle framing (last hard build) — unchanged
 *   wk2 → 0.55  build week (muscle lane only)      — new
 *   wk1 → 0.5   intro week  (muscle lane only)     — new
 */
export function buildBlockPosition(
  blockWeek: number | null,
  todayIso: string,
  goal?: 'strength' | 'muscle' | 'general' | null,
): BlockPositionObservation | null {
  const wk = Number.isInteger(blockWeek) ? blockWeek : null;
  if (wk !== 1 && wk !== 2 && wk !== 3 && wk !== 4) return null;
  const isMuscleLane = goal === 'muscle';
  // Weeks 1 and 2 only speak on the muscle lane — strength has no volume
  // ramp to narrate here (progression is load-side, spoken by the lift
  // progression observations).
  if ((wk === 1 || wk === 2) && !isMuscleLane) return null;

  let salience: number;
  if (wk === 4) salience = 0.95;
  else if (wk === 3) salience = 0.7;
  else if (wk === 2) salience = 0.55;
  else salience = 0.5;

  // factSig carries the goal on wk1/2 so a user who switches from muscle
  // to strength mid-block doesn't re-hear stale ramp copy (goal advances
  // the sig). Weeks 3/4 keep the bare `block-N` sig to preserve dedup
  // continuity with pre-v8 stored messages.
  const factSig = wk <= 2 ? `block-${wk}-g${goal ?? 'x'}` : `block-${wk}`;

  return {
    type: 'block_position',
    id: `block_position:${wk}`,
    factSig,
    salience,
    eventDate: todayIso,
    blockWeek: wk as 1 | 2 | 3 | 4,
    goal: goal ?? null,
  };
}

/**
 * Effort-zone read over the recent rated-set window.
 *   pct ≥ 0.60 → 'productive band'  (factSig effort-high)
 *   pct < 0.30 → 'drifting easy'    (factSig effort-low)
 *   else null (the autoregulation is working fine; nothing to say).
 *
 * Salience 0.5. Requires at least 5 rated sets to be meaningful — anything
 * below noise.
 */
export function buildEffortZone(
  effortZone: { hits: number; total: number },
  todayIso: string,
): EffortZoneObservation | null {
  if (!effortZone || effortZone.total < 5) return null;
  const pct = effortZone.hits / effortZone.total;
  if (pct >= 0.6) {
    return {
      type: 'effort_zone',
      id: 'effort_zone',
      factSig: 'effort-high',
      salience: 0.5,
      eventDate: todayIso,
      band: 'high',
      pct,
    };
  }
  if (pct < 0.3) {
    return {
      type: 'effort_zone',
      id: 'effort_zone',
      factSig: 'effort-low',
      salience: 0.5,
      eventDate: todayIso,
      band: 'low',
      pct,
    };
  }
  return null;
}

/** Required volume of rated sets before "dialed_in" can fire. Tuned to
 *  sit AFTER the cold-start calibration window (which gates on
 *  totalCompleted < 6 — typically <8 rated sets) so the two never
 *  overlap. See the test in coachObservations.test.ts that pins this. */
const DIALED_IN_MIN_TOTAL = 8;

/** Hit-rate floor for "dialed_in". 0.7 = 70% of rated sets land in the
 *  1–2 RIR target zone — strong enough signal that the autoregulator
 *  is actually following the user, not coincidence. */
const DIALED_IN_MIN_RATE = 0.7;

/**
 * "The engine is dialed in to you" trust message. Reads the SAME
 * (hits, total) signal buildEffortZone uses; the two are intentionally
 * disjoint:
 *
 *   - effort_zone fires at total ≥ 5 with pct ≥ 0.6 (positive band) or
 *     pct < 0.3 (negative band) — the existing analytics readout.
 *   - dialed_in fires at total ≥ 8 with pct ≥ 0.7 — a stronger trust
 *     signal that lets the autoregulator visibly take credit for the
 *     calibration the user feels.
 *
 * Both can technically pass their guards at high pct, but in the
 * selector the higher-salience dialed_in (0.6) outranks effort_zone
 * (0.5) and the cold-start calibration's bare 'calibration' factSig
 * dedup keeps the engine-just-meeting-you and the engine-now-tuned
 * lines from co-firing on the same focus.
 *
 * factSig buckets the rate to one decimal (`dialed-${round(pct*10)}`)
 * so the line doesn't re-speak until the rate meaningfully changes —
 * 72% → 75% stays at `dialed-7`, 75% → 81% advances to `dialed-8` and
 * the line speaks again.
 *
 * Returns null when there isn't enough signal yet — never claims
 * "dialed in" when it isn't. The honesty rule is enforced at this
 * boundary; the phraser downstream can trust the inputs.
 */
export function buildDialedIn(
  effortZone: { hits: number; total: number },
  todayIso: string,
): DialedInObservation | null {
  if (!effortZone) return null;
  const total = Math.max(0, Math.floor(effortZone.total ?? 0));
  const hits = Math.max(0, Math.floor(effortZone.hits ?? 0));
  if (total < DIALED_IN_MIN_TOTAL) return null;
  const pct = hits / total;
  if (pct < DIALED_IN_MIN_RATE) return null;
  return {
    type: 'dialed_in',
    id: 'dialed_in',
    factSig: `dialed-${Math.round(pct * 10)}`,
    salience: 0.6,
    eventDate: todayIso,
    hits,
    total,
    pct,
  };
}

// ── Comeback gap helper ────────────────────────────────────────────────
//
// Pulled out of the home focus loader so it's unit-testable. The early
// false-positive ("brand-new user gets 'back after N missed sessions' as
// their first coach message") shipped because this logic was trapped
// inside the React state-fetch path with no test coverage. Now it's a pure
// function and every guard has a unit test below.

export interface GapDaysInput {
  /** Days between the user's earliest completed session (within the
   *  caller's window — 45d in the dashboard wire-up) and today. Used to
   *  decide whether a baseline exists at all AND to prorate the expected
   *  count for users who just crossed the 14-day mark. Null = no completed
   *  sessions; collapses to 0 internally and naturally fails the >=14
   *  baseline guard — behavior identical to the pre-null callers. */
  firstSessionDaysAgo: number | null;
  /** Total completed sessions the caller observed. The dashboard derives
   *  this from the same 45-day fetch — a user who has trained <3 times
   *  has no baseline to "come back" to. */
  totalCompleted: number;
  /** Days since the user's most recent completed session. <4 means the
   *  user is still showing up — missed scheduled sessions while present
   *  is NOT a comeback. Pass +Infinity when no completed session exists. */
  daysSinceLast: number;
  /** profiles.training_days. 0..7. */
  trainingDays: number;
  /** Distinct completed days in the last 14 calendar days. */
  trainedDays14: number;
}

/**
 * Compute the comeback gap (missed-scheduled-day approximation).
 *
 * Returns 0 — which disables buildComeback — unless ALL of:
 *   • Baseline established:  totalCompleted ≥ 3 AND firstSessionDaysAgo ≥ 14
 *   • Recent absence:        daysSinceLast ≥ 4
 *
 * When both guards pass, the prorated expected count is
 *   round(trainingDays / 7 × min(14, firstSessionDaysAgo))
 * and gapDays = max(0, expected − trainedDays14). The min(14, …) cap means
 * users right at the 14-day mark don't get a phantom gap from a
 * full-fortnight expected against a shorter actual history.
 *
 * The caller still funnels this through buildComeback, which applies the
 * ≥3 floor and produces the observation.
 */
export function computeGapDays(input: GapDaysInput): number {
  const totalCompleted = Math.max(0, Math.floor(input.totalCompleted ?? 0));
  // null → 0 → baseline guard `< 14` fails → returns 0. Behaviour
  // identical to the pre-null callers; the null shape exists so the
  // dashboard layer can express "brand new user" honestly to the cold-
  // start observation builders too.
  const firstSessionDaysAgo = Math.max(
    0,
    Math.floor(input.firstSessionDaysAgo == null ? 0 : input.firstSessionDaysAgo),
  );
  const daysSinceLast = Number.isFinite(input.daysSinceLast)
    ? Math.max(0, Math.floor(input.daysSinceLast))
    : Number.POSITIVE_INFINITY;
  const trainingDays = Math.max(0, Math.min(7, Math.floor(input.trainingDays ?? 0)));
  const trainedDays14 = Math.max(0, Math.floor(input.trainedDays14 ?? 0));

  // Guard 1 — established baseline. Without 3+ completed sessions AND a
  // history that goes back at least two weeks, the word "comeback" is a
  // lie: there's nothing to come back to.
  if (totalCompleted < 3) return 0;
  if (firstSessionDaysAgo < 14) return 0;

  // Guard 2 — actual recent absence. Missing scheduled sessions while
  // still showing up in the last 3 days is normal life, not a comeback.
  if (daysSinceLast < 4) return 0;

  // Prorate expected count by the observable history length, capped at
  // 14d. trainingDays=0 short-circuits to 0 — a rest-only user has no
  // expected sessions to miss.
  if (trainingDays === 0) return 0;
  const lookback = Math.min(14, firstSessionDaysAgo);
  const expected = Math.round((trainingDays / 7) * lookback);
  return Math.max(0, expected - trainedDays14);
}

/**
 * Whole-training comeback. gapDays here is the CALLER'S CORRECTED metric —
 * missed scheduled training days (expected − completed in the trailing
 * window), NOT raw calendar days. That correction is what closes the
 * "user trains 3×/week, took a 7-day calendar gap, got falsely flagged"
 * false-positive the old gap-modal path had. Threshold: gapDays ≥ 3.
 *
 * The caller is expected to gate gapDays via computeGapDays above — a
 * brand-new or ramping-up user must come through as 0 so the BRAIN
 * doesn't say "back after N missed sessions" before there's anything to
 * be back FROM.
 */
export function buildComeback(
  gapDays: number,
  todayIso: string,
): ComebackObservation | null {
  const g = Math.floor(gapDays ?? 0);
  if (!Number.isFinite(g) || g < 3) return null;
  return {
    type: 'comeback',
    id: 'comeback',
    factSig: `gap-${g}`,
    // Demoted from 1.0. Coming back from missed sessions is meaningful
    // but the SAME-DAY action — what to do today — sits above it
    // (deload week / pushing_hard / stall all carry the "what now"
    // information a comeback line lacks).
    salience: 0.65,
    eventDate: todayIso,
    gapDays: g,
  };
}

/**
 * Cold-start "why this plan" observation. Explains the split choice in
 * terms of training days — gives the new user a reason to trust the
 * structure before they've earned any specific feedback.
 *
 * Guard: totalCompleted < 8 AND split != null. Auto-retires past 8
 * completed sessions; once real observations land (salience 0.7–1.0) the
 * selector also outranks this (0.55) before then. factSig is per-split
 * so a returning user who bumps their schedule from 2 to 3 days re-hears
 * the rationale for the new split (rationale-upper_lower → rationale-ppl).
 */
export function buildPlanRationale(
  split: string | null,
  trainingDays: number | null,
  totalCompleted: number,
  todayIso: string,
  opts?: { goal?: PlanRationaleGoal | null; priority?: string | null },
): PlanRationaleObservation | null {
  if (!split) return null;
  if (Math.floor(totalCompleted ?? 0) >= 8) return null;
  const td = Math.max(0, Math.min(7, Math.floor(trainingDays ?? 0)));
  const goal = opts?.goal ?? null;
  const priorityRaw = (opts?.priority ?? '').trim().toLowerCase();
  const priority = priorityRaw === '' ? null : priorityRaw;
  // factSig advances with goal/priority so a returning user whose onboarding
  // inputs change re-hears the new line. Legacy callers that omit opts keep
  // the bare `rationale-${split}` sig so existing dedup history continues
  // to apply — the per-personalisation suffix is appended only when there's
  // something extra to encode.
  const suffix =
    goal == null && priority == null
      ? ''
      : `-g${goal ?? 'x'}-p${priority ?? 'x'}`;
  return {
    type: 'plan_rationale',
    id: `plan_rationale:${split}`,
    factSig: `rationale-${split}${suffix}`,
    salience: 0.55,
    eventDate: todayIso,
    split,
    trainingDays: td,
    goal,
    priority,
  };
}

/**
 * Cold-start "I'm learning you" observation. The first-two-weeks framing
 * that explains why the coach hasn't said anything specific yet.
 *
 * Guard: (firstSessionDaysAgo == null OR firstSessionDaysAgo < 14) AND
 * totalCompleted < 6. factSig is the bare literal `'calibration'` — once
 * it's been spoken once (memory guard via appendCoachMessageOnce), it's a
 * permanent no-op. That's the "once in the window" semantics by design.
 */
export function buildCalibration(
  firstSessionDaysAgo: number | null,
  totalCompleted: number,
  todayIso: string,
): CalibrationObservation | null {
  const inWindow = firstSessionDaysAgo == null || firstSessionDaysAgo < 14;
  if (!inWindow) return null;
  if (Math.floor(totalCompleted ?? 0) >= 6) return null;
  return {
    type: 'calibration',
    id: 'calibration',
    factSig: 'calibration',
    salience: 0.6,
    eventDate: todayIso,
  };
}

/**
 * Last-resort filler so the card never goes silent on a training day. Only
 * surfaces when the selector finds nothing else (see selectTopObservations).
 * Salience 0.1 keeps it below the 0.3 floor; it's only let through via the
 * "empty result → fallback" branch.
 */
export function buildBriefingFallback(
  todayWorkoutType: string | null,
  todayExerciseCount: number,
  todayIso: string,
): BriefingFallbackObservation | null {
  const wt = (todayWorkoutType ?? '').trim();
  const n = Math.max(0, Math.floor(todayExerciseCount ?? 0));
  if (!wt || n <= 0) return null;
  return {
    type: 'briefing_fallback',
    id: 'briefing_fallback',
    factSig: `brief-${todayIso}`,
    salience: 0.1,
    eventDate: todayIso,
    workoutType: wt,
    exerciseCount: n,
  };
}

/**
 * Rest-day baseline. The mirror of buildBriefingFallback for a day with no
 * planned training: fires when today is a rest day (workoutType null/empty
 * or 'Rest' AND zero exercises). Mutually exclusive with briefing_fallback
 * by construction — that one needs ≥1 exercise, this one needs 0.
 *
 * Salience 0.1 (same filler tier as the briefing fallback): the selector
 * only surfaces it when nothing real wins, so a PR / streak / deload on a
 * rest day still leads. Its sole job is to beat a stale prior-day briefing
 * for the top card slot. factSig is per-day (`rest-${todayIso}`) so it's a
 * fresh message each rest day — distinct from `brief-*`, so it's never
 * deduped against yesterday's briefing.
 */
export function buildRestDay(
  todayWorkoutType: string | null,
  todayExerciseCount: number,
  todayIso: string,
): RestDayObservation | null {
  const wt = (todayWorkoutType ?? '').trim();
  const n = Math.max(0, Math.floor(todayExerciseCount ?? 0));
  const isRestDay = wt === '' || wt.toLowerCase() === 'rest';
  if (!isRestDay || n > 0) return null;
  return {
    type: 'rest_day',
    id: 'rest_day',
    factSig: `rest-${todayIso}`,
    salience: 0.1,
    eventDate: todayIso,
  };
}

// ── Composite (synthesis) builders ─────────────────────────────────────
// Each is pure and fires ONLY on its co-occurrence condition. They read the
// already-built lift observations plus the fatigue counts, so the synthesis
// can never claim history the single facts don't support.

/** Minimal per-lift shape the composites consume — the data-bearing fields
 *  of a lift_progression observation, by subtype. */
export interface LiftFact {
  name: string;
  /** The observation id this lift fact came from (for subsumption), or null
   *  for a declining lift (which has no single observation of its own). */
  id: string | null;
  to?: number; // up: latest top weight
}

const COMPOSITE_FATIGUE_MIN = 2;

/**
 * pushing_hard — progression on key lifts WHILE fatigue is repeating
 * (≥2 low-energy sessions and/or ≥2 RIR misses). Subsumes every "up" fact so
 * the coach says the synthesis, not "bench up". GREEN-LIGHT tier (0.9) —
 * leads when no protective read fires (grinding 0.96, block_position:4 0.95).
 */
export function buildPushingHard(
  progressing: LiftFact[],
  lowEnergySessions: number,
  rirMissSets: number,
  todayIso: string,
): PushingHardObservation | null {
  if (!progressing || progressing.length === 0) return null;
  const low = Math.max(0, Math.floor(lowEnergySessions ?? 0)) >= COMPOSITE_FATIGUE_MIN;
  const rir = Math.max(0, Math.floor(rirMissSets ?? 0)) >= COMPOSITE_FATIGUE_MIN;
  if (!low && !rir) return null;
  const fatigue: PushingHardObservation['fatigue'] = low && rir ? 'both' : low ? 'low_energy' : 'rir_misses';
  // Headline the strongest mover (highest latest top weight).
  const top = progressing.reduce((a, b) => ((b.to ?? 0) > (a.to ?? 0) ? b : a));
  return {
    type: 'pushing_hard',
    id: 'pushing_hard',
    factSig: `pushing-${fmtFactKg(top.to ?? 0)}-${fatigue}`,
    salience: 0.9,
    eventDate: todayIso,
    lift: top.name,
    fatigue,
    subsumes: progressing.map(p => p.id).filter((x): x is string => x != null),
  };
}

/**
 * grinding — a stall or decline WHILE energy is repeatedly low (≥2). The
 * slog: acknowledge it and point at recovery. Subsumes the stall facts (a
 * decline has no single observation). PROTECTIVE tier (0.96) — the lead
 * read when it fires; ahead of block_position:4 (0.95).
 */
export function buildGrinding(
  strained: Array<LiftFact & { kind: 'stall' | 'decline' }>,
  lowEnergySessions: number,
  todayIso: string,
): GrindingObservation | null {
  if (!strained || strained.length === 0) return null;
  if (Math.max(0, Math.floor(lowEnergySessions ?? 0)) < COMPOSITE_FATIGUE_MIN) return null;
  // Prefer naming a stall (it carries an id to subsume); else the first decline.
  const chosen = strained.find(s => s.kind === 'stall') ?? strained[0];
  return {
    type: 'grinding',
    id: 'grinding',
    factSig: `grinding-${chosen.name}-${chosen.kind}`,
    salience: 0.96,
    eventDate: todayIso,
    lift: chosen.name,
    strain: chosen.kind,
    subsumes: strained.map(s => s.id).filter((x): x is string => x != null),
  };
}

/**
 * back_on_track — a recent comeback FOLLOWED by fresh progression. The return
 * is working. Subsumes the comeback + up facts it ties together. Salience 0.9.
 */
export function buildBackOnTrack(
  hasComeback: boolean,
  comebackIds: string[],
  progressing: LiftFact[],
  todayIso: string,
): BackOnTrackObservation | null {
  if (!hasComeback) return null;
  if (!progressing || progressing.length === 0) return null;
  const top = progressing.reduce((a, b) => ((b.to ?? 0) > (a.to ?? 0) ? b : a));
  return {
    type: 'back_on_track',
    id: 'back_on_track',
    factSig: `backontrack-${fmtFactKg(top.to ?? 0)}`,
    // GREEN-LIGHT tier — sits just under pushing_hard (0.9) so a
    // co-occurring "running hot" read still leads when both qualify.
    salience: 0.88,
    eventDate: todayIso,
    lift: top.name,
    subsumes: [
      ...(comebackIds ?? []),
      ...progressing.map(p => p.id).filter((x): x is string => x != null),
    ],
  };
}

/** A fresh declining lift: most recent session is within 14d AND its top
 *  weight dropped from the prior session. Declines produce no single
 *  observation (buildLiftProgression returns null), so this is the only
 *  place they're detected — for the grinding composite. */
function hasFreshDecline(sessionsOldestFirst: LiftSessionTop[], todayIso: string): boolean {
  if (!sessionsOldestFirst || sessionsOldestFirst.length < 2) return false;
  const last = sessionsOldestFirst[sessionsOldestFirst.length - 1];
  if (daysBetween(last.date, todayIso) >= 14) return false; // dormant — not fresh
  const prev = sessionsOldestFirst[sessionsOldestFirst.length - 2];
  return last.topKg < prev.topKg;
}

// ── Aggregation ────────────────────────────────────────────────────────

/**
 * Run every builder. Order in the returned array is not meaningful —
 * selectTopObservations does the ranking. Per-lift progression and session
 * PRs are emitted once per lift. Composite (synthesis) observations are
 * appended too; the selector suppresses the single facts a composite subsumes.
 */
export function deriveObservations(input: ObservationsInput): CoachObservation[] {
  const out: CoachObservation[] = [];

  // Per-lift progression — at most one observation per lift. Kept so the
  // composites below can read the per-lift facts (and ids) they synthesize.
  const liftObs: LiftProgressionObservation[] = [];
  for (const lift of Object.keys(input.liftSessions)) {
    const obs = buildLiftProgression(lift, input.liftSessions[lift], input.todayIso);
    if (obs) { liftObs.push(obs); out.push(obs); }
  }

  // Per-lift session PRs (finish flow only).
  for (const pr of input.sessionPrs ?? []) {
    const obs = buildSessionPr(pr.lift, pr.newKg, pr.prevKg, input.todayIso);
    if (obs) out.push(obs);
  }

  const cons = buildConsistency(input.trainedDays14, input.trainedDays28, input.todayIso);
  if (cons) out.push(cons);

  const block = buildBlockPosition(input.blockWeek, input.todayIso, input.goal ?? null);
  if (block) out.push(block);

  const ez = buildEffortZone(input.effortZone, input.todayIso);
  if (ez) out.push(ez);

  const dialedIn = buildDialedIn(input.effortZone, input.todayIso);
  if (dialedIn) out.push(dialedIn);

  const cb = buildComeback(input.gapDays, input.todayIso);
  if (cb) out.push(cb);

  const rationale = buildPlanRationale(
    input.split,
    input.trainingDays,
    input.totalCompleted,
    input.todayIso,
    { goal: input.goal ?? null, priority: input.priority ?? null },
  );
  if (rationale) out.push(rationale);

  const calibration = buildCalibration(
    input.firstSessionDaysAgo,
    input.totalCompleted,
    input.todayIso,
  );
  if (calibration) out.push(calibration);

  const fallback = buildBriefingFallback(
    input.todayWorkoutType,
    input.todayExerciseCount,
    input.todayIso,
  );
  if (fallback) out.push(fallback);

  // Rest-day mirror of the briefing fallback. Mutually exclusive with it
  // (briefing needs ≥1 exercise; rest needs 0), so at most one of the two
  // is ever emitted on a given day.
  const restDay = buildRestDay(
    input.todayWorkoutType,
    input.todayExerciseCount,
    input.todayIso,
  );
  if (restDay) out.push(restDay);

  // ── Composite synthesis (at most one per focus) ──────────────────────
  // Read the per-lift facts already built plus the fatigue counts. Priority:
  // running-hot (pushing_hard) > the return working (back_on_track) > the
  // slog (grinding). Emitting one keeps the card from stacking two judgments.
  const progressing: LiftFact[] = liftObs
    .filter(o => o.subtype === 'up')
    .map(o => ({ name: o.lift, id: o.id, to: (o as Extract<LiftProgressionObservation, { subtype: 'up' }>).to }));
  const strained: Array<LiftFact & { kind: 'stall' | 'decline' }> = [
    ...liftObs
      .filter(o => o.subtype === 'stall')
      .map(o => ({ name: o.lift, id: o.id, kind: 'stall' as const })),
    ...Object.keys(input.liftSessions)
      .filter(lift => hasFreshDecline(input.liftSessions[lift], input.todayIso))
      .map(lift => ({ name: lift, id: null, kind: 'decline' as const })),
  ];
  const liftComebackIds = liftObs.filter(o => o.subtype === 'comeback').map(o => o.id);
  const hasComeback = liftComebackIds.length > 0 || cb != null;
  const comebackIds = [...liftComebackIds, ...(cb ? [cb.id] : [])];
  const lowEnergySessions = input.lowEnergySessions ?? 0;
  const rirMissSets = input.rirMissSets ?? 0;

  const composite =
    buildPushingHard(progressing, lowEnergySessions, rirMissSets, input.todayIso) ??
    buildBackOnTrack(hasComeback, comebackIds, progressing, input.todayIso) ??
    buildGrinding(strained, lowEnergySessions, input.todayIso);
  if (composite) out.push(composite);

  return out;
}

// ── Selector ───────────────────────────────────────────────────────────

export interface SelectorOpts {
  /** factSigs already spoken recently (typically the last ~20 dedupKeys
   *  pulled from the coach-message store). Observations whose factSig is
   *  in this set are dropped — the memory guard. */
  recentFactSigs: ReadonlySet<string>;
  /** Hard cap on returned observations. Default 2. */
  max?: number;
}

/** Lower bound on salience for everything EXCEPT the briefing fallback. */
const SALIENCE_FLOOR = 0.3;
/** A second slot is earned only by a salience ≥ this. */
const SECOND_SLOT_FLOOR = 0.8;

/**
 * Pick the headline observations for this focus.
 *
 *   1. Drop any whose factSig is in recentFactSigs (memory guard).
 *   2. Drop salience < 0.3, EXCEPT briefing_fallback (handled in step 5).
 *   3. Rank by salience desc, ties broken by eventDate desc (most recent
 *      wins) then by id for total determinism.
 *   4. Take top 1; add a 2nd ONLY if its salience ≥ 0.8.
 *   5. If the result is empty, emit the day's fallback iff one was derived
 *      (briefing_fallback on a training day, rest_day on a rest day) and its
 *      factSig isn't already in recentFactSigs. Otherwise return [].
 *
 * Composite preference: when a composite (synthesis) observation would
 * surface (it's not memory-guarded and clears the floor), the single facts it
 * `subsumes` are dropped from the candidate pool, so the coach speaks the
 * connected read ("pushing hard") instead of the disconnected parts ("bench
 * up"). A composite already in recentFactSigs does NOT suppress its parts —
 * the memory guard stays the single source of "already said this".
 */
export function selectTopObservations(
  obs: CoachObservation[],
  opts: SelectorOpts,
): CoachObservation[] {
  const recent = opts.recentFactSigs;
  const max = opts.max ?? 2;

  // Both filler observations are handled the same way: they're the baseline
  // for the day (training vs rest) and only surface when nothing real wins.
  // At most one of the two exists on any given day (mutually exclusive in
  // deriveObservations).
  const isFallback = (o: CoachObservation): boolean =>
    o.type === 'briefing_fallback' || o.type === 'rest_day';
  const fallback = obs.find(isFallback) ?? null;

  // Subsumption: an ACTIVE composite (would-surface: not recently spoken, above
  // the floor) replaces its component single-facts. Only active composites
  // suppress — a memory-guarded composite leaves its parts to compete.
  const subsumed = new Set<string>();
  for (const o of obs) {
    if (isCompositeObservation(o) && !recent.has(o.factSig) && o.salience >= SALIENCE_FLOOR) {
      for (const id of o.subsumes) subsumed.add(id);
    }
  }

  // Strip out anything already spoken, the fallbacks (handled separately so
  // the floor below doesn't kill them), and any single fact a composite subsumes.
  const candidates = obs.filter(
    o => !isFallback(o) && !recent.has(o.factSig) && o.salience >= SALIENCE_FLOOR && !subsumed.has(o.id),
  );

  candidates.sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    if (b.eventDate !== a.eventDate) return b.eventDate < a.eventDate ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const picked: CoachObservation[] = [];
  if (candidates.length > 0) {
    picked.push(candidates[0]);
    if (max >= 2 && candidates[1] && candidates[1].salience >= SECOND_SLOT_FLOOR) {
      picked.push(candidates[1]);
    }
  }

  if (picked.length === 0 && fallback && !recent.has(fallback.factSig)) {
    picked.push(fallback);
  }

  return picked.slice(0, max);
}
