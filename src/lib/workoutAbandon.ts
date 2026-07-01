// Pure helpers for the workout-abandon flow.
//
// Abandon = DISCARD + EXIT. It is NOT a completion path. The previous
// implementation called finishWorkout() when any set was logged — which
// marked the session completed:true and wrote it to workout_sessions,
// turning "I want out of this workout" into "this workout is done."
// That confused the consistency streak, fired a recap, and left the
// user staring at a finished-session card they never wanted.
//
// In-progress data lives only in the active workout screen's in-memory
// state (weightLogRef / rirLogRef). Nothing is persisted per-set —
// runFinishPersistence is the only writer, and it runs exclusively from
// finishWorkout(). So abandon has no remote rollback to do; the entire
// "discard" is a local memory clear.
//
// Keeping the abandon plan as data (an array of named actions) instead of
// inlining the calls in the screen lets a test assert structurally that
// no completion-class action ever appears here — the regression we want
// to prevent.

export type AbandonAction =
  | { kind: 'clearWeightLog' }
  | { kind: 'clearRirLog' }
  | { kind: 'navigateHome' };

export interface AbandonInputs {
  /** Whether any set has been logged in memory. Currently unused by the
   *  plan — the discard steps are the same either way — but kept as a
   *  parameter so future callers can pass session context without
   *  re-shaping the API. */
  hasLoggedSets: boolean;
}

/**
 * The ordered list of actions the screen should run when the user
 * confirms "Abandon". The contract this function defends:
 *
 *   • The returned plan ALWAYS contains the in-memory clears and the
 *     navigation step.
 *   • The returned plan NEVER contains a persistence/completion step.
 *     The `AbandonAction` union itself excludes those kinds — the
 *     pure test pins that union and any future addition of a
 *     "persistSession" or "markCompleted" kind would have to be
 *     intentional and would be visible in review.
 */
export function planAbandon(_inputs: AbandonInputs): AbandonAction[] {
  // The kg map is the user's progress; the RIR map mirrors it. Clearing
  // both stops a stale value from leaking into the next session's
  // prescription if the user starts a new workout in the same JS
  // session. Navigation comes last so the screen unmounts after the
  // clears land.
  return [
    { kind: 'clearWeightLog' },
    { kind: 'clearRirLog' },
    { kind: 'navigateHome' },
  ];
}

/**
 * Body text for the abandon confirmation modal. The previous copy was
 * tone-mismatched with reality — it told the user "what you've logged
 * will be saved" because the underlying handler called finishWorkout(),
 * which DID save it as a completed session. Now that abandon truly
 * discards, the copy has to say so unambiguously, with no branching on
 * whether sets exist — the answer is the same either way.
 */
export function abandonModalCopy(_inputs: AbandonInputs): {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
} {
  return {
    title: 'Abandon workout?',
    body: "Your progress won't be saved.",
    confirmLabel: 'Abandon',
    cancelLabel: 'Keep training',
  };
}
