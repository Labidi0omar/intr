// Campaign-status builder — the post-workout coach-card message that frames
// training as an ongoing campaign instead of a one-off "workout completed":
//
//   Week 3 of the hypertrophy block.
//   Bench press up 7.5 kg since week 1.
//   Recovery is stable.
//   Deload in 5 days.
//
// Pure and deterministic — built entirely from data already in scope in
// app/workout.tsx's finish flow (blockWeek, the current plan's week_start,
// today's logs, per-exercise history, today's energy score). No network, no
// invented numbers: every line is dropped when its backing fact is missing,
// and the whole message is null when the mesocycle position is unknown
// (the regular recap already covers those sessions).
//
// Appended once per day to the coach-message store with kind 'campaign'
// and dedupKey `campaign:{yyyy-mm-dd}` right after the recap, so it lands
// as the newest message on the dashboard card.

export interface CampaignTodayLog {
  exercise_name: string;
  /** null = bodyweight; bodyweight lifts never drive the progress line. */
  weight_kg: number | null;
}

export interface BuildCampaignStatusArgs {
  /** YYYY-MM-DD local. */
  todayStr: string;
  /** In-block week (1–4). Undefined ⇒ no campaign message at all. */
  blockWeek?: number;
  /** week_start (YYYY-MM-DD) of the current plan row. Anchors the exact
   *  deload countdown and the block-start window; when missing both fall
   *  back to week-granularity approximations. */
  weekStart?: string;
  /** Today's pre-workout energy score (1–5). */
  energyScore: number;
  /** Lifts logged today (workout.tsx's todayLogs shape, superset OK). */
  todayLogs: CampaignTodayLog[];
  /** Up to ~6 most recent prior logs per exercise, newest first
   *  (workout.tsx's exerciseHistory). */
  exerciseHistory: Record<string, { weight_kg: number; date: string }[]>;
}

const BLOCK_WEEKS = 4;

/** Parse YYYY-MM-DD into a local-midnight Date, or null on garbage. */
function parseDay(s: string): Date | null {
  const p = s.split('-').map(Number);
  if (p.length !== 3 || p.some(isNaN)) return null;
  return new Date(p[0], p[1] - 1, p[2]);
}

function toDayStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Whole days from a to b, negative when b is earlier. */
function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** 7.5 → "7.5", 5 → "5" — kg deltas read clean either way. */
function formatKg(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Best positive weight gain across today's lifts vs each lift's oldest
 *  logged session inside the current block window. Exported for tests. */
export function bestBlockProgress(
  args: Pick<BuildCampaignStatusArgs, 'todayStr' | 'todayLogs' | 'exerciseHistory'> & {
    blockStartStr: string;
  },
): { name: string; delta: number } | null {
  let pick: { name: string; delta: number } | null = null;
  for (const log of args.todayLogs) {
    if (typeof log.weight_kg !== 'number') continue;
    const hist = args.exerciseHistory[log.exercise_name] ?? [];
    // History is newest-first; the last in-window entry is the block baseline.
    let baseline: number | null = null;
    for (const h of hist) {
      if (!h || !h.date || typeof h.weight_kg !== 'number') continue;
      if (h.date >= args.todayStr) continue; // today / future rows are not priors
      if (h.date < args.blockStartStr) break; // older than the block — stop
      baseline = h.weight_kg;
    }
    if (baseline === null) continue;
    const delta = log.weight_kg - baseline;
    if (delta > 0 && (!pick || delta > pick.delta)) {
      pick = { name: log.exercise_name, delta };
    }
  }
  return pick;
}

/**
 * Build the campaign-status message, or null when blockWeek is unknown.
 * Lines (each dropped independently when its fact is missing):
 *   1. Week N of the hypertrophy block — always (blockWeek is required).
 *   2. <Lift> up X kg since week 1 — best in-block gain on a lift trained
 *      today; skipped on week 1 (week 1 IS the baseline) and on deload week
 *      (the dose was reduced on purpose, nothing to celebrate).
 *   3. Recovery line from today's energy score.
 *   4. Deload countdown — exact days when weekStart is known, otherwise
 *      week-granularity; "Deload week" framing on week 4.
 */
export function buildCampaignStatus(args: BuildCampaignStatusArgs): string | null {
  const { todayStr, blockWeek, weekStart, energyScore, todayLogs, exerciseHistory } = args;
  if (blockWeek === undefined || blockWeek < 1 || blockWeek > BLOCK_WEEKS) return null;
  const today = parseDay(todayStr);
  if (!today) return null;

  const isDeloadWeek = blockWeek === BLOCK_WEEKS;
  const lines: string[] = [];

  lines.push(
    isDeloadWeek
      ? `Week ${blockWeek} of the hypertrophy block — deload.`
      : `Week ${blockWeek} of the hypertrophy block.`,
  );

  // Progress since week 1. The block started (blockWeek - 1) weeks before
  // the current plan week; without weekStart we approximate the window as
  // blockWeek * 7 days back from today (one week of slack is fine — the
  // baseline is still the oldest in-block session).
  if (blockWeek > 1 && !isDeloadWeek) {
    const ws = weekStart ? parseDay(weekStart) : null;
    const blockStart = ws
      ? addDays(ws, -(blockWeek - 1) * 7)
      : addDays(today, -blockWeek * 7);
    const progress = bestBlockProgress({
      todayStr,
      todayLogs,
      exerciseHistory,
      blockStartStr: toDayStr(blockStart),
    });
    if (progress) {
      lines.push(`${cap(progress.name)} up ${formatKg(progress.delta)} kg since week 1.`);
    }
  }

  if (energyScore >= 4) lines.push('Recovery is strong.');
  else if (energyScore === 3) lines.push('Recovery is stable.');
  else if (energyScore >= 1) lines.push('Recovery is running low — sleep is part of the program.');

  if (isDeloadWeek) {
    lines.push('Recover hard — next block starts from here.');
  } else {
    const ws = weekStart ? parseDay(weekStart) : null;
    if (ws) {
      const deloadStart = addDays(ws, (BLOCK_WEEKS - blockWeek) * 7);
      const days = diffDays(today, deloadStart);
      if (days > 0) lines.push(`Deload in ${days} day${days === 1 ? '' : 's'}.`);
    } else {
      const weeks = BLOCK_WEEKS - blockWeek;
      lines.push(`Deload in ${weeks} week${weeks === 1 ? '' : 's'}.`);
    }
  }

  return lines.join('\n');
}
