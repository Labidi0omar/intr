// Tiny build/version marker used to verify that a JS reload actually
// picked up the latest bundle. Bump BUILD_TAG every time you make a change
// you want to confirm on device — when the new tag shows up at the bottom
// of the Profile tab, you know the reload took. If you still see the old
// tag (or nothing), Metro is serving a stale bundle.
//
// Format is freeform; convention is 'b1', 'b2', 'b3', … so an at-a-glance
// jump is obvious. Keep it short — it renders in a footer, not a banner.

export const BUILD_TAG = 'b15';

/** Master switch for the AI rephrasing layer on top of the deterministic
 *  coach voice. When false (the default until the edge function is
 *  deployed and ANTHROPIC_API_KEY is set), every wire-up site sticks to
 *  the deterministic phraseObservation line — the AI upgrade is silently
 *  skipped. Fails OPEN to deterministic if the function/key is missing
 *  at request time too, so flipping this on accidentally can't take the
 *  card down. See src/lib/coachVoiceAI.ts. */
export const COACH_AI_VOICE = false;
