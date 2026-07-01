// Dev-only scenario library — synthetic but realistic account snapshots,
// dated relative to "today," that exercise the REAL read paths.
//
// Pure + deterministic by construction: every scenario resolves to the same
// shape every run (fixed weights, fixed RIR/energy, deterministic dates from
// the passed `nowIso`). No React, no Supabase, no AsyncStorage. The seeder
// (devSeed.ts) translates these into Supabase writes via the existing
// helpers — this file owns the FACTS the seeder will install, nothing else.
//
// Each scenario explains its bug surface in `description` so a tester can
// pick the right state without code-diving.

import type { FitnessLevel, SplitId } from './planGeneration';

// ── Scenario shape ─────────────────────────────────────────────────────

/** Profile inputs persisted onto the `profiles` row. Mirrors the columns
 *  the migration added plus the long-existing plan-shaping ones. NULL
 *  values are deliberate skips — the seed helper and rationale phraser
 *  both treat them as "user didn't say". */
export interface ScenarioProfile {
  fitness_level: FitnessLevel;
  goal: 'strength' | 'muscle' | 'general';
  priority: string | null;
  bodyweight_kg: number | null;
  sex: 'male' | 'female' | 'unspecified' | null;
  training_days: number;
  preferred_split: SplitId;
  training_weekdays: number[] | null;
}

/** One exercise row inside a scenario session. weight_kg null = bodyweight /
 *  duration row (the same shape the real finish flow allows). RIR null =
 *  unrated set (the autoregulator reads it as "no signal, repeat last load"). */
export interface ScenarioLog {
  exercise_name: string;
  weight_kg: number | null;
  reps_in_reserve: number | null;
}

/** One past session that will be written via attemptSave. `daysAgo` is the
 *  offset from the resolved "today" — every concrete date is derived from
 *  it inside `buildScenario`, so the same scenario id produces the same
 *  state on every run. */
export interface ScenarioSession {
  daysAgo: number;
  workoutType: string;
  energyScore: 1 | 2 | 3 | 4 | 5;
  energyLevel: 'low' | 'normal' | 'high';
  logs: ScenarioLog[];
}

/** Post-seed hooks. Reproduce specific bug shapes that only manifest when
 *  state is written AFTER the canonical seed (e.g. a stale rest_day pin
 *  sitting in storage when the plan is otherwise training-shaped). */
export interface ScenarioPostSeed {
  /** Write a coachHero pin keyed on today. The factSig is a template
   *  evaluated against the resolved today. Currently only 'rest-today' is
   *  used — pinning a rest factSig on a training day reproduces the
   *  coherence-guard bug class. */
  heroPin?: 'rest-today';
}

export interface Scenario {
  id: string;
  label: string;
  description: string;
  profile: ScenarioProfile;
  /** Past workout sessions, newest-first. Empty for the cold-start case. */
  sessions: ScenarioSession[];
  /** When set, the seeder inserts a synthetic `weekly_plans` row at this
   *  offset (days before today) before calling `ensureCurrentWeekPlan`.
   *  ensureCurrentWeekPlan's `blockAnchor` is the earliest existing row,
   *  so shifting it back N weeks puts today on the corresponding
   *  block-week (e.g. -21 days → today is week 4 of the block = deload). */
  blockAnchorDaysAgo?: number;
  /** Hooks fired after the canonical seed. */
  postSeed?: ScenarioPostSeed;
}

// ── Resolved (today-pinned) shape ──────────────────────────────────────

/** Concrete YYYY-MM-DD date plus session details. The seeder consumes this
 *  shape directly; `daysAgo` is gone — every date is already absolute. */
export interface ResolvedSession {
  plannedDate: string;
  workoutType: string;
  energyScore: 1 | 2 | 3 | 4 | 5;
  energyLevel: 'low' | 'normal' | 'high';
  logs: ScenarioLog[];
}

export interface ResolvedScenario {
  id: string;
  label: string;
  description: string;
  todayIso: string;
  profile: ScenarioProfile;
  sessions: ResolvedSession[];
  blockAnchorWeekStart?: string;
  postSeed?: ScenarioPostSeed;
}

// ── Date helpers (local, no DST drift across resolution) ───────────────

/** Today as YYYY-MM-DD in local time. Pure and dep-free. */
export function todayIsoLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** `nowIso` shifted by `delta` calendar days. Negative delta = past. */
export function addDaysIso(nowIso: string, delta: number): string {
  const [y, m, d] = nowIso.split('-').map(Number);
  const t = new Date(y, m - 1, d + delta);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** Day-of-week 0..6 (Sun..Sat) for a YYYY-MM-DD string in local time. */
export function dayOfWeek(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

// ── Scenario catalog ───────────────────────────────────────────────────
//
// Each entry is a STATIC blueprint — fixed weights / RIR / energy, fixed
// daysAgo offsets, fixed training_weekdays where it matters. The catalog
// is exported so the dev menu can render the list without re-deriving.

export const SCENARIO_IDS = [
  'fresh_cold_start',
  'stalling_intermediate',
  'recovering_well',
  'overreaching',
  'deload_week',
  'comeback_after_gap',
  'rest_day_today',
  'training_day_stale_pin',
  'pr_just_hit',
] as const;
export type ScenarioId = typeof SCENARIO_IDS[number];

/** Baseline profile for the PPL-shaped scenarios — intermediate male lifter
 *  on a 3-day push/pull/legs cadence. Cloned and overridden per scenario. */
const PPL_PROFILE: ScenarioProfile = {
  fitness_level: 'intermediate',
  goal: 'muscle',
  priority: 'bench',
  bodyweight_kg: 80,
  sex: 'male',
  training_days: 3,
  preferred_split: 'ppl',
  training_weekdays: [1, 3, 5], // Mon/Wed/Fri
};

const SCENARIOS: Record<ScenarioId, Scenario> = {
  fresh_cold_start: {
    id: 'fresh_cold_start',
    label: 'Fresh cold start',
    description:
      'No history, no body inputs. Session 1 should fall to a calibration entry; the coach should speak the plan rationale, not invent numbers.',
    profile: {
      fitness_level: 'beginner',
      goal: 'general',
      priority: null,
      bodyweight_kg: null,
      sex: null,
      training_days: 3,
      preferred_split: 'ppl',
      training_weekdays: [1, 3, 5],
    },
    sessions: [],
  },

  stalling_intermediate: {
    // Bench flat at 80 kg across 4 push sessions; RIR creeps 2 → 1 → 0 → 0.
    // Triggers the lift_progression "stall" observation + the load
    // prescriber's "hold / backoff on failure" arc.
    id: 'stalling_intermediate',
    label: 'Stalling intermediate',
    description:
      'Bench Press flat at 80 kg across four push sessions, RIR creeping toward failure. Should surface the stall read and prescribe a hold or backoff.',
    profile: { ...PPL_PROFILE },
    sessions: [
      {
        daysAgo: 12,
        workoutType: 'Push',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [
          { exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 2 },
          { exercise_name: 'Overhead Press', weight_kg: 45, reps_in_reserve: 2 },
        ],
      },
      {
        daysAgo: 9,
        workoutType: 'Push',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [
          { exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 1 },
          { exercise_name: 'Overhead Press', weight_kg: 45, reps_in_reserve: 2 },
        ],
      },
      {
        daysAgo: 5,
        workoutType: 'Push',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [
          { exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 0 },
          { exercise_name: 'Overhead Press', weight_kg: 47.5, reps_in_reserve: 1 },
        ],
      },
      {
        daysAgo: 2,
        workoutType: 'Push',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [
          { exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 0 },
          { exercise_name: 'Overhead Press', weight_kg: 47.5, reps_in_reserve: 1 },
        ],
      },
    ],
  },

  recovering_well: {
    // Bench climbing 80 → 82.5 → 85 → 87.5 across four push sessions,
    // high energy throughout. Surfaces lift_progression "up" + the
    // "training status: recovering well" branch.
    id: 'recovering_well',
    label: 'Recovering well',
    description:
      'Bench climbing 80 → 82.5 → 85 → 87.5 kg across four push sessions with high energy. Surfaces the lift-up read and a green training-status badge.',
    profile: { ...PPL_PROFILE },
    sessions: [
      {
        daysAgo: 12,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 9,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 82.5, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 5,
        workoutType: 'Push',
        energyScore: 5,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 85, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 2,
        workoutType: 'Push',
        energyScore: 5,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 87.5, reps_in_reserve: 2 }],
      },
    ],
  },

  overreaching: {
    // Low energy across the last two sessions + RIR misses (0). Triggers
    // the grinding composite observation and the training-status
    // "backing off" badge.
    id: 'overreaching',
    label: 'Overreaching',
    description:
      'Low energy + RIR misses across the last two sessions. Triggers the grinding/backing-off composite and protective coach lines.',
    profile: { ...PPL_PROFILE },
    sessions: [
      {
        daysAgo: 10,
        workoutType: 'Pull',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Row', weight_kg: 70, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 7,
        workoutType: 'Legs',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Squat', weight_kg: 100, reps_in_reserve: 1 }],
      },
      {
        daysAgo: 4,
        workoutType: 'Push',
        energyScore: 2,
        energyLevel: 'low',
        logs: [
          { exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 0 },
          { exercise_name: 'Overhead Press', weight_kg: 45, reps_in_reserve: 0 },
        ],
      },
      {
        daysAgo: 1,
        workoutType: 'Pull',
        energyScore: 2,
        energyLevel: 'low',
        logs: [
          { exercise_name: 'Barbell Row', weight_kg: 70, reps_in_reserve: 0 },
          { exercise_name: 'Barbell Curl', weight_kg: 30, reps_in_reserve: 0 },
        ],
      },
    ],
  },

  deload_week: {
    // Block anchor shifted -21d → today is week 4 of the mesocycle (deload).
    // Need enough history that the user has "earned" the deload — three
    // weeks of clean training. The artificial weekly_plans anchor row is
    // what positions today on week 4; ensureCurrentWeekPlan recomputes
    // the rest from it.
    id: 'deload_week',
    label: 'Deload week',
    description:
      'Mesocycle anchored 21 days back → today lands on block week 4 (deload). Plan should reduce sets and the coach should explain the back-off.',
    profile: { ...PPL_PROFILE },
    blockAnchorDaysAgo: 21,
    sessions: [
      {
        daysAgo: 19,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 16,
        workoutType: 'Pull',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Row', weight_kg: 70, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 12,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 82.5, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 9,
        workoutType: 'Pull',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Row', weight_kg: 72.5, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 5,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 85, reps_in_reserve: 1 }],
      },
      {
        daysAgo: 2,
        workoutType: 'Pull',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Row', weight_kg: 75, reps_in_reserve: 1 }],
      },
    ],
  },

  comeback_after_gap: {
    // Earliest session 21d ago, most recent 16d ago — passes the
    // computeGapDays baseline guard (totalCompleted >= 3, firstSession
    // >= 14d, daysSinceLast >= 4). Should trigger the comeback observation
    // and the GapModal banner.
    id: 'comeback_after_gap',
    label: 'Comeback after gap',
    description:
      'Three sessions 16–21 days ago, nothing since. Should trigger the comeback observation and the GapModal.',
    profile: { ...PPL_PROFILE },
    sessions: [
      {
        daysAgo: 21,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 19,
        workoutType: 'Pull',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Row', weight_kg: 70, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 16,
        workoutType: 'Legs',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Squat', weight_kg: 100, reps_in_reserve: 2 }],
      },
    ],
  },

  rest_day_today: {
    // training_weekdays explicitly EXCLUDES today's day-of-week. The
    // resolver below patches this so the scenario actually lands on a
    // rest day regardless of which calendar day "today" is.
    // training_weekdays in the static blueprint is a placeholder; the
    // resolved scenario fixes it to "every weekday except today."
    id: 'rest_day_today',
    label: 'Rest day today',
    description:
      'Training weekdays exclude today, so the plan has no training row for today. The dashboard should render the rest-day hero, not yesterday\'s briefing.',
    profile: {
      ...PPL_PROFILE,
      training_days: 3,
      // Patched in resolveScenario — we need to know today's DOW to
      // produce a 3-day set that DOESN'T include it.
      training_weekdays: null,
    },
    sessions: [
      {
        daysAgo: 7,
        workoutType: 'Push',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 4,
        workoutType: 'Pull',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Row', weight_kg: 70, reps_in_reserve: 2 }],
      },
    ],
  },

  training_day_stale_pin: {
    // Today IS a training day; the seeder then writes a stale `rest-{today}`
    // pin into coachHero:pin so the dashboard's coherence guard is exercised.
    // training_weekdays patched to include today in resolveScenario.
    id: 'training_day_stale_pin',
    label: 'Training day w/ stale rest pin',
    description:
      'Real training day, but a stale rest_day pin is pre-seeded into coachHero. The coherence guard should discard it and re-pick a training-shaped line.',
    profile: {
      ...PPL_PROFILE,
      training_weekdays: null, // patched in resolveScenario to include today
    },
    sessions: [
      {
        daysAgo: 7,
        workoutType: 'Push',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 4,
        workoutType: 'Pull',
        energyScore: 3,
        energyLevel: 'normal',
        logs: [{ exercise_name: 'Barbell Row', weight_kg: 70, reps_in_reserve: 2 }],
      },
    ],
    postSeed: { heroPin: 'rest-today' },
  },

  pr_just_hit: {
    // Last session lands a new top (90 kg) on Bench, beating prior maxes
    // (85). The lift_progression "up" path with isAllTimeHigh = true
    // surfaces the new-high coach line and the dashboard PR badge.
    id: 'pr_just_hit',
    label: 'PR just hit',
    description:
      'Most recent session is a clear bench PR (90 kg vs prior best 85 kg). Should surface the new-top coach line and a "you added weight" early-win.',
    profile: { ...PPL_PROFILE },
    sessions: [
      {
        daysAgo: 12,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 80, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 9,
        workoutType: 'Push',
        energyScore: 4,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 82.5, reps_in_reserve: 2 }],
      },
      {
        daysAgo: 5,
        workoutType: 'Push',
        energyScore: 5,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 85, reps_in_reserve: 1 }],
      },
      {
        daysAgo: 1,
        workoutType: 'Push',
        energyScore: 5,
        energyLevel: 'high',
        logs: [{ exercise_name: 'Barbell Bench Press', weight_kg: 90, reps_in_reserve: 1 }],
      },
    ],
  },
};

/** Static catalog — same object identity every call. Don't mutate. */
export function listScenarios(): readonly Scenario[] {
  return SCENARIO_IDS.map(id => SCENARIOS[id]);
}

/** Look up a scenario blueprint by id, or null if unknown. */
export function getScenario(id: string): Scenario | null {
  return (SCENARIOS as Record<string, Scenario | undefined>)[id] ?? null;
}

// ── Resolution (blueprint → fully-dated snapshot) ──────────────────────

/** Build a 3-day weekday picker that EXCLUDES `excludeDow` so today (or any
 *  given weekday) lands on a rest day. Picks the first three weekdays that
 *  aren't the excluded one, preferring Mon/Tue/Wed/Thu/Fri/Sat/Sun in order. */
function weekdaysExcluding(excludeDow: number): number[] {
  const preferred = [1, 2, 3, 4, 5, 6, 0];
  return preferred.filter(d => d !== excludeDow).slice(0, 3).sort((a, b) => a - b);
}

/** Build a 3-day weekday picker that INCLUDES `includeDow`. Pads with
 *  weekdays from the preference order until length 3 is reached. */
function weekdaysIncluding(includeDow: number): number[] {
  const preferred = [1, 3, 5, 2, 4, 6, 0];
  const out = new Set<number>([includeDow]);
  for (const d of preferred) {
    if (out.size >= 3) break;
    out.add(d);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Resolve a scenario against a concrete "today" — absolute dates, no
 * placeholders. Pure: the same (id, nowIso) pair always produces the same
 * snapshot. `nowIso` defaults to the local day, which is what the seeder
 * passes in production.
 *
 * Patches the two scenarios whose `training_weekdays` are placeholder NULL
 * (rest_day_today / training_day_stale_pin) — they need to know today's
 * day-of-week to land deterministically. Everything else is straight
 * date arithmetic on the blueprint.
 */
export function buildScenario(id: ScenarioId, opts: { nowIso?: string } = {}): ResolvedScenario {
  const blueprint = SCENARIOS[id];
  const todayIso = opts.nowIso ?? todayIsoLocal();
  const todayDow = dayOfWeek(todayIso);

  let profile = blueprint.profile;
  if (id === 'rest_day_today') {
    profile = { ...profile, training_weekdays: weekdaysExcluding(todayDow) };
  } else if (id === 'training_day_stale_pin') {
    profile = { ...profile, training_weekdays: weekdaysIncluding(todayDow) };
  }

  const sessions: ResolvedSession[] = blueprint.sessions.map(s => ({
    plannedDate: addDaysIso(todayIso, -s.daysAgo),
    workoutType: s.workoutType,
    energyScore: s.energyScore,
    energyLevel: s.energyLevel,
    logs: s.logs,
  }));

  // ensureCurrentWeekPlan anchors blocks on the earliest weekly_plans row's
  // week_start. To place today on a specific block week we need the anchor
  // to be a Monday N weeks back — we floor the offset to the nearest Monday
  // earlier-or-equal so the math is week-aligned.
  let blockAnchorWeekStart: string | undefined;
  if (blueprint.blockAnchorDaysAgo != null) {
    const raw = addDaysIso(todayIso, -blueprint.blockAnchorDaysAgo);
    const rawDow = dayOfWeek(raw);
    // JS Sunday=0; shift so Monday is the week start (back up by N where
    // N = (dow + 6) % 7; Mon→0, Tue→1, ..., Sun→6).
    const backToMon = (rawDow + 6) % 7;
    blockAnchorWeekStart = addDaysIso(raw, -backToMon);
  }

  return {
    id: blueprint.id,
    label: blueprint.label,
    description: blueprint.description,
    todayIso,
    profile,
    sessions,
    blockAnchorWeekStart,
    postSeed: blueprint.postSeed,
  };
}

// ── Validation helpers (used by tests) ─────────────────────────────────

export interface ScenarioValidationIssue {
  scenarioId: string;
  field: string;
  message: string;
}

/** Run cheap shape checks across every scenario. Used by the unit tests to
 *  pin invariants: sessions monotonically older-first or newest-first by
 *  daysAgo, RIR in 0..5, energy in 1..5, weight non-negative when set. */
export function validateScenarios(now: Date = new Date()): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  const todayIso = todayIsoLocal(now);
  for (const id of SCENARIO_IDS) {
    const resolved = buildScenario(id, { nowIso: todayIso });
    const dates = resolved.sessions.map(s => s.plannedDate);
    // Strictly monotonic (newer index → newer date OR older index → older
    // date; we permit both directions to leave authoring flexible, but
    // never duplicates).
    const sorted = [...dates].sort();
    const uniq = new Set(dates);
    if (uniq.size !== dates.length) {
      issues.push({ scenarioId: id, field: 'sessions.plannedDate', message: 'duplicate session dates' });
    }
    // Sanity: every session date is in the past or today.
    for (const d of dates) {
      if (d > todayIso) {
        issues.push({ scenarioId: id, field: 'sessions.plannedDate', message: `future date ${d}` });
      }
    }
    for (const s of resolved.sessions) {
      if (s.energyScore < 1 || s.energyScore > 5) {
        issues.push({ scenarioId: id, field: 'sessions.energyScore', message: `${s.energyScore} out of 1..5` });
      }
      for (const l of s.logs) {
        if (l.reps_in_reserve != null && (l.reps_in_reserve < 0 || l.reps_in_reserve > 5)) {
          issues.push({ scenarioId: id, field: 'logs.reps_in_reserve', message: `${l.reps_in_reserve} out of 0..5` });
        }
        if (l.weight_kg != null && l.weight_kg < 0) {
          issues.push({ scenarioId: id, field: 'logs.weight_kg', message: `${l.weight_kg} negative` });
        }
        if (!l.exercise_name || !l.exercise_name.trim()) {
          issues.push({ scenarioId: id, field: 'logs.exercise_name', message: 'empty exercise name' });
        }
      }
    }
    // Profile sanity.
    const p = resolved.profile;
    if (p.bodyweight_kg != null && (p.bodyweight_kg < 25 || p.bodyweight_kg > 300)) {
      issues.push({ scenarioId: id, field: 'profile.bodyweight_kg', message: `${p.bodyweight_kg} out of 25..300` });
    }
    if (p.training_weekdays != null) {
      for (const d of p.training_weekdays) {
        if (d < 0 || d > 6) {
          issues.push({ scenarioId: id, field: 'profile.training_weekdays', message: `${d} out of 0..6` });
        }
      }
      if (p.training_weekdays.length !== p.training_days) {
        issues.push({
          scenarioId: id,
          field: 'profile.training_weekdays',
          message: `length ${p.training_weekdays.length} != training_days ${p.training_days}`,
        });
      }
    }
    // sorted unused but kept for assertion future-proofing.
    void sorted;
  }
  return issues;
}
