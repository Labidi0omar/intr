// Pure PR detection for the workout finish flow.
//
// PR = "new best within PR_WINDOW_DAYS" — the caller fetches prior
// exercise_logs bounded by that window and this module does the comparison.
//
// The critical contract this module exists to enforce: the durable save
// runs BEFORE the prior-log fetch (see runFinishPersistence in
// pendingSync.ts — that ordering is what keeps a flaky PR read from ever
// losing a session). The fetch therefore sees the session's OWN
// just-inserted rows. Without excluding them, every comparison degenerates
// to `newWeight > newWeight` → false, and genuine PRs silently vanish —
// including the first-time badge, because the lift's own row masquerades
// as a prior. Rows logged on or after the session date are never priors.
//
// Inputs are keyed by exercise_name exactly as committed in the session's
// logRows — for a swapped exercise that's the NEW name (the commit path
// writes under workout[i].name, which is the post-swap identity). A
// swapped-in lift with no history under its new name surfaces as a
// first-time badge rather than being suppressed by the old lift's history.

export interface SessionLogRow {
  exercise_name: string;
  /** Numeric kg. Null = bodyweight/duration-only — excluded from PR
   *  detection entirely (we never fabricate a bodyweight PR). */
  weight_kg: number | null;
}

export interface PriorLogRow {
  exercise_name: string;
  weight_kg: number | null;
  /** When present, rows dated on/after the session date are ignored
   *  (self-exclusion guard). Absent = trusted as a genuine prior, for
   *  callers that already bounded the fetch. */
  logged_date?: string | null;
}

export interface SessionPrMeta {
  name: string;
  newWeightKg: number;
  prevBestKg: number;
}

export interface SessionPrResult {
  /** Exercise names to celebrate on the completion screen. Includes
   *  first-time lifts (no prior in the window). */
  prs: string[];
  /** Coach-message meta — ONLY lifts with a genuine prior best to beat.
   *  First-time lifts populate the badge but never a "New PR" message. */
  meta: SessionPrMeta[];
  /** Committed weight per logged exercise — the PR card's display source,
   *  taken from the same rows the durable save persisted. */
  prWeights: Record<string, number>;
}

export function computeSessionPrs(
  logRows: readonly SessionLogRow[],
  priorLogs: readonly PriorLogRow[],
  sessionDate: string,
): SessionPrResult {
  // Best prior per exercise, excluding anything logged on/after the
  // session date — see the module header for why the session's own rows
  // come back from the fetch.
  const bestPrior = new Map<string, number>();
  for (const p of priorLogs) {
    if (p.weight_kg == null || !isFinite(p.weight_kg)) continue;
    if (p.logged_date && p.logged_date >= sessionDate) continue;
    const cur = bestPrior.get(p.exercise_name);
    if (cur === undefined || p.weight_kg > cur) bestPrior.set(p.exercise_name, p.weight_kg);
  }

  const prs: string[] = [];
  const meta: SessionPrMeta[] = [];
  const prWeights: Record<string, number> = {};
  for (const row of logRows) {
    if (row.weight_kg == null || !isFinite(row.weight_kg)) continue; // bodyweight
    prWeights[row.exercise_name] = row.weight_kg;
    const prevMax = bestPrior.get(row.exercise_name);
    if (prevMax === undefined || row.weight_kg > prevMax) prs.push(row.exercise_name);
    if (prevMax !== undefined && row.weight_kg > prevMax) {
      meta.push({ name: row.exercise_name, newWeightKg: row.weight_kg, prevBestKg: prevMax });
    }
  }
  return { prs, meta, prWeights };
}
