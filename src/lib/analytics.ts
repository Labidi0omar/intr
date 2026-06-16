import { supabase } from './supabase';
import { reportSilent } from './errorReporting';

// One-purpose analytics: enough to answer "is the product working?" each Friday.
// Schema: see supabase/migrations/20260527010000_events_table.sql
//
// Rules:
//   1. Fire-and-forget. Never await. Never throw. Never block a UX action.
//   2. event_name is one of the literal types below — no free-form strings.
//   3. properties is small: numbers, short strings, booleans. Never PII beyond user_id.

export type EventName =
  | 'signup'
  | 'onboarding_started'
  | 'onboarding_completed'
  | 'plan_ready'
  | 'workout_started'
  | 'workout_completed'
  | 'activation_reached'
  | 'replan_offered'
  | 'replan_accepted'
  | 'deload_action'
  | 'paywall_shown'
  | 'subscription_started'
  | 'prescription_shown'
  | 'prescription_outcome';

export interface EventProperties {
  session_index?: number;
  energy_score?: number;
  replanned?: boolean;
  product_id?: string;
  paywall_reason?: 'session_gate' | 'feature_gate';
  /** GapModal replan_offered/replan_accepted source — distinguishes the
   *  stranded-miss anchor from the legacy 3-day return-gap detector. */
  replan_source?: 'unfinished_anchor' | 'return_gap';
  /** GapModal replan_accepted action — resume = make up missed sessions,
   *  skip = advance past them on normal cadence. */
  replan_action?: 'resume' | 'skip';
  /** Training Status deload action — early = pull the deload forward,
   *  skip = un-deload the scheduled week-4 row and keep pushing. */
  deload_action?: 'early' | 'skip';
  // Allow null so RIR (which is nullable in the DB) can be preserved in the
  // JSON payload rather than dropped silently.
  [k: string]: string | number | boolean | null | undefined;
}

/**
 * Fire-and-forget event log. Resolves silently on any failure — analytics
 * should never break a user flow.
 */
export function track(event: EventName, properties: EventProperties = {}): void {
  // Don't block the caller; insert in the background.
  void (async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from('events').insert({
        user_id: user.id,
        event_name: event,
        properties,
      });
    } catch (e) {
      // Never propagate. Analytics outages don't break workouts. We still
      // tell Sentry so a broken events table (RLS, missing column) is
      // visible — analytics drop is itself a bug worth knowing about.
      reportSilent(e, 'analytics:trackInsert', { event });
    }
  })();
}

/**
 * How many completed workouts does this user have? Used to compute the next
 * `session_index` (1-indexed) for paywall gating and analytics.
 */
export async function getCompletedWorkoutCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('workout_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('completed', true);
  if (error) {
    reportSilent(error, 'analytics:getCompletedWorkoutCount');
    return 0;
  }
  return count ?? 0;
}
