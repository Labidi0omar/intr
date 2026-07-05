import { supabase } from '../lib/supabase';
import { hitTargetZone, type Goal } from '../lib/loadPrescription';
import { reportSilent } from '../lib/errorReporting';
import { isRecoveryLog, type RecoveryLogLike } from '../lib/recovery';

// Shared dashboard stats. Both home.tsx and progress.tsx import the
// effort-zone helper so the two screens can never drift. Strength-trend
// is dashboard-only today but lives here next to its sibling so future
// readers find both together.

/** Row shape we read from exercise_logs. weight_kg may be a stringified
 *  number, a bodyweight marker like 'bw', or null on legacy rows.
 *  `is_recovery` is optional for backwards compatibility with prefetched
 *  rows that don't include it; the pure helpers below treat its absence
 *  as "not recovery" (so callers that already pre-filter still work). */
export interface ExerciseLogRow extends RecoveryLogLike {
  exercise_name: string;
  weight_kg: number | string | null;
  reps_in_reserve: number | null;
  logged_date: string; // YYYY-MM-DD
}

export interface EffortZone {
  hits: number;
  total: number;
}

/** Most-recent N rated sets (reps_in_reserve != null), counted into the
 *  goal-aware target zone. `goal` is optional — omitting it falls back to
 *  the current 1-2 window (general lane), which keeps analytics for legacy
 *  callers byte-identical. When goal is provided, strength users' hits
 *  count against 2-3, muscle users' against 0-2 — the analytics % agrees
 *  with the RIR ladder the engine actually used.
 */
export function computeEffortZoneFromLogs(
  logsAscByDate: ExerciseLogRow[],
  recentWindow = 30,
  goal?: Goal,
): EffortZone {
  if (!Array.isArray(logsAscByDate) || logsAscByDate.length === 0) {
    return { hits: 0, total: 0 };
  }
  const recentRated: ExerciseLogRow[] = [];
  for (let i = logsAscByDate.length - 1; i >= 0 && recentRated.length < recentWindow; i--) {
    const row = logsAscByDate[i];
    // Recovery rows must never count toward effort-zone — light prehab
    // dosed at RIR 3+ would drag the user's "training in the target zone"
    // percentage down without representing any actual training decision.
    if (row && !isRecoveryLog(row) && row.reps_in_reserve != null) recentRated.push(row);
  }
  if (recentRated.length === 0) return { hits: 0, total: 0 };
  const hits = recentRated.filter(r => hitTargetZone(r.reps_in_reserve ?? null, goal)).length;
  return { hits, total: recentRated.length };
}

/** Async convenience: pull the user's exercise_logs and compute the zone.
 *  Never throws — returns {hits:0,total:0} on any failure. */
export async function computeEffortZone(userId: string, recentWindow = 30, goal?: Goal): Promise<EffortZone> {
  try {
    const { data } = await supabase
      .from('exercise_logs')
      .select('exercise_name, weight_kg, reps_in_reserve, logged_date, is_recovery')
      .eq('user_id', userId)
      // Belt-and-suspenders: the pure helper also drops recovery rows, but
      // filtering at the query keeps the payload small for active users.
      .eq('is_recovery', false)
      .order('logged_date', { ascending: true });
    return computeEffortZoneFromLogs((data ?? []) as ExerciseLogRow[], recentWindow, goal);
  } catch (e) {
    reportSilent(e, 'dashboardStats:effortZone');
    return { hits: 0, total: 0 };
  }
}

// ── Strength trend ────────────────────────────────────────────────────

export interface StrengthTrend {
  /** Sum of per-exercise (recentMax - priorMax) across exercises that have
   *  numeric weight in BOTH windows. null when no exercise overlaps both. */
  deltaKg: number | null;
  /** How many exercises contributed (had data in both windows). */
  exercisesCompared: number;
  /** Every compared lift's signed delta (recentMax − priorMax), so the
   *  Training Status engine can count progressing vs declining lifts without
   *  re-windowing. Empty when nothing overlapped both windows. Optional so
   *  callers building partial fixtures stay valid. */
  perLift?: Array<{ name: string; deltaKg: number }>;
  /** The single biggest mover — the compared lift with the greatest signed
   *  delta. Lets the dashboard say "Squat +5 kg" instead of an aggregate.
   *  null when nothing overlapped both windows. Can be negative in a down
   *  stretch; the renderer decides how to present a non-positive mover. */
  topMover?: { name: string; deltaKg: number } | null;
}

/** Parse weight_kg honestly. Bodyweight tags ('bw', 'BW', 'bodyweight')
 *  and non-numeric junk return null and are excluded by the trend. */
export function parseWeightKg(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === '' || t === 'bw' || t === 'bodyweight') return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** YYYY-MM-DD (local) for `today` shifted by `daysAgo`. */
function isoDaysAgo(daysAgo: number, today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Compare per-exercise max weight in two windows:
 *   recent: (today - recentDays) .. today           (default last 14d)
 *   prior:  (today - priorDays)  .. (today - recentDays - 1)  (default 15..35d ago)
 * deltaKg = sum across exercises that have numeric logs in BOTH windows
 * of (recentMax - priorMax). Bodyweight/non-numeric rows excluded.
 * Returns deltaKg=null when no exercise has overlap — caller renders "—".
 */
export function computeStrengthTrendFromLogs(
  logs: ExerciseLogRow[],
  opts: { recentDays?: number; priorDays?: number; today?: Date } = {}
): StrengthTrend {
  const recentDays = opts.recentDays ?? 14;
  const priorDays = opts.priorDays ?? 35;
  const today = opts.today ?? new Date();

  if (!Array.isArray(logs) || logs.length === 0) {
    return { deltaKg: null, exercisesCompared: 0, perLift: [], topMover: null };
  }

  const recentStart = isoDaysAgo(recentDays - 1, today);            // inclusive: last `recentDays` days incl. today
  const priorEnd = isoDaysAgo(recentDays, today);                   // day before recent window
  const priorStart = isoDaysAgo(priorDays - 1, today);              // earliest day in prior window

  // exerciseName -> { recentMax, priorMax }
  const acc = new Map<string, { recentMax: number | null; priorMax: number | null }>();

  for (const row of logs) {
    if (!row || !row.exercise_name || !row.logged_date) continue;
    // Recovery rows must never contribute to the strength trend — light
    // prehab weights would deform the trend and could even fabricate a
    // negative delta on a recovery-heavy week.
    if (isRecoveryLog(row)) continue;
    const w = parseWeightKg(row.weight_kg);
    if (w == null) continue;

    const d = row.logged_date;
    let bucket: 'recent' | 'prior' | null = null;
    if (d >= recentStart) bucket = 'recent';
    else if (d >= priorStart && d <= priorEnd) bucket = 'prior';
    if (!bucket) continue;

    const cur = acc.get(row.exercise_name) ?? { recentMax: null, priorMax: null };
    if (bucket === 'recent') {
      cur.recentMax = cur.recentMax == null ? w : Math.max(cur.recentMax, w);
    } else {
      cur.priorMax = cur.priorMax == null ? w : Math.max(cur.priorMax, w);
    }
    acc.set(row.exercise_name, cur);
  }

  let total = 0;
  let compared = 0;
  const perLift: Array<{ name: string; deltaKg: number }> = [];
  let topMover: { name: string; deltaKg: number } | null = null;
  for (const [name, { recentMax, priorMax }] of acc.entries()) {
    if (recentMax == null || priorMax == null) continue;
    const deltaKg = recentMax - priorMax;
    total += deltaKg;
    compared++;
    perLift.push({ name, deltaKg });
    // Biggest mover = greatest signed delta. Ties resolve to the
    // first encountered (Map preserves insertion order) so the pick is
    // deterministic for a given log set.
    if (!topMover || deltaKg > topMover.deltaKg) topMover = { name, deltaKg };
  }

  if (compared === 0) return { deltaKg: null, exercisesCompared: 0, perLift: [], topMover: null };
  return { deltaKg: total, exercisesCompared: compared, perLift, topMover };
}

/** Async convenience: pull logs and compute the trend. Never throws. */
export async function computeStrengthTrend(
  userId: string,
  opts?: { recentDays?: number; priorDays?: number }
): Promise<StrengthTrend> {
  try {
    const { data } = await supabase
      .from('exercise_logs')
      .select('exercise_name, weight_kg, reps_in_reserve, logged_date, is_recovery')
      .eq('user_id', userId)
      // Pre-filter at the query so the JS-side pure check is a redundancy,
      // not a load-bearing filter on an unbounded payload.
      .eq('is_recovery', false)
      .order('logged_date', { ascending: true });
    return computeStrengthTrendFromLogs((data ?? []) as ExerciseLogRow[], opts);
  } catch (e) {
    reportSilent(e, 'dashboardStats:strengthTrend');
    return { deltaKg: null, exercisesCompared: 0 };
  }
}

/** Format for the dashboard card: "+5 kg", "+0 kg", or "—". */
export function formatStrengthTrend(trend: StrengthTrend): string {
  if (trend.deltaKg == null) return '—';
  const rounded = Math.round(trend.deltaKg);
  if (rounded > 0) return `+${rounded} kg`;
  if (rounded < 0) return `${rounded} kg`;
  return '+0 kg';
}
