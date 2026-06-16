import { supabase } from './supabase';

// Mirror the server-side PlanDay shape from supabase/functions/_shared/safety.ts.
// Keeping it loose (no strict type sharing) so client / edge fn can drift
// independently if needed.
export interface ReplannerExercise {
  name: string;
  sets: number;
  reps: string | number;
  restSeconds: number;
  primaryMuscle: string;
  equipment?: string;
  imageUrl?: string;
  suggestedWeightKg?: number;
}

export interface ReplannerPlanDay {
  day: string;
  location: string;
  workoutType: string;
  muscleGroups: string[];
  exercises: ReplannerExercise[];
}

export interface ReplannerResponse {
  adjusted_plan_day: ReplannerPlanDay;
  changes: string[];
  reasoning: string;
  usage: {
    tier: 'free' | 'pro';
    limit: number;
    used: number;
  };
}

export type ReplannerResult =
  | { kind: 'ok'; data: ReplannerResponse }
  | { kind: 'limit_reached'; tier: 'free' | 'pro'; limit: number; used: number }
  | { kind: 'safety_rejected'; reason: string }
  | { kind: 'error'; message: string };

interface RequestArgs {
  planDay: ReplannerPlanDay;
  energyScore: number;
}

/**
 * Invoke the replan-today edge function. Translates the SDK's opaque
 * `FunctionsHttpError` into a discriminated union the UI can switch on.
 */
export async function requestReplan(args: RequestArgs): Promise<ReplannerResult> {
  try {
    const { data, error } = await supabase.functions.invoke('replan-today', {
      body: { plan_day: args.planDay, energy_score: args.energyScore },
    });

    if (error) {
      // Try to extract the body — supabase-js stashes the underlying Response
      // on `error.context`. The edge fn returns structured JSON for known errors.
      let bodyJson: any = null;
      try {
        const ctx = (error as any).context;
        if (ctx && typeof ctx.json === 'function') {
          bodyJson = await ctx.json();
        }
      } catch {
        // ignore — fall through to generic error below
      }

      if (bodyJson?.error === 'Monthly replan limit reached') {
        return {
          kind: 'limit_reached',
          tier: bodyJson.tier,
          limit: bodyJson.limit,
          used: bodyJson.used,
        };
      }
      if (typeof bodyJson?.error === 'string' && bodyJson.keep_original) {
        return { kind: 'safety_rejected', reason: bodyJson.error };
      }
      return { kind: 'error', message: bodyJson?.error ?? error.message ?? 'Unknown error' };
    }

    if (!data || !data.adjusted_plan_day) {
      return { kind: 'error', message: 'Empty response from coach' };
    }

    return { kind: 'ok', data: data as ReplannerResponse };
  } catch (e: any) {
    return { kind: 'error', message: e?.message ?? String(e) };
  }
}
