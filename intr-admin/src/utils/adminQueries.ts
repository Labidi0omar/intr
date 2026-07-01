// ─────────────────────────────────────────────────────────────────────────────
// Typed Supabase fetchers for the admin dashboard.
//
// Every read goes through the single anon `supabase` client and is therefore
// subject to RLS: a logged-in admin (profiles.is_admin = true) sees all rows via
// the *_select_admin policies; anyone else sees only their own. There is no
// privileged key involved. Each fetcher throws on a Postgres error so callers can
// surface a real error/empty state instead of silently rendering nothing.
//
// Column lists mirror the live schema (project ehbbpawgntvykkiioukl):
//   profiles:         id, username, fitness_level, goal, preferred_split,
//                     onboarding_complete, created_at, training_days, is_admin
//   workout_sessions: id, user_id, planned_date, completed_at, workout_type,
//                     location, energy_level, completed, exercises_done,
//                     created_at, replanned, is_recovery
//   journal_entries:  user_id, date, user_text, ai_response, created_at
//   events:           id, user_id, event_name, properties, created_at
//   exercise_logs:    id, user_id, exercise_name, weight_kg, logged_date,
//                     session_id, created_at, reps_in_reserve, is_recovery
//   exercises:        id, name, primary_muscle, ...  (public read)
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

export interface ProfileRow {
  id: string;
  username: string | null;
  fitness_level: string | null;
  goal: string | null;
  preferred_split: string | null;
  onboarding_complete: boolean | null;
  created_at: string;
  training_days: number | null;
}

export interface SessionRow {
  user_id: string;
  planned_date: string;
  completed_at: string | null;
  workout_type: string | null;
  energy_level: string | null;
  completed: boolean | null;
  is_recovery: boolean | null;
  created_at: string;
}

export interface JournalRow {
  user_id: string;
  date: string;
  created_at: string;
  user_text: string | null;
}

export interface EventRow {
  id: string;
  user_id: string | null;
  event_name: string;
  created_at: string;
}

export interface ExerciseLogRow {
  user_id: string;
  exercise_name: string;
  weight_kg: number | null;
  logged_date: string | null;
  reps_in_reserve: number | null;
  is_recovery: boolean | null;
}

export interface ExerciseCatalogRow {
  name: string;
  primary_muscle: string | null;
}

// ── Date helpers (UTC calendar-day strings, matching how rows are stored) ─────
export const todayISO = (): string => new Date().toISOString().split('T')[0];

export function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function unwrap<T>(data: T[] | null, error: { message: string } | null): T[] {
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Safe message extraction for a caught unknown error. */
export const errMessage = (e: unknown, fallback: string): string =>
  e instanceof Error ? e.message : fallback;

export async function fetchProfiles(): Promise<ProfileRow[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, fitness_level, goal, preferred_split, onboarding_complete, created_at, training_days');
  return unwrap(data as ProfileRow[] | null, error);
}

export async function fetchSessions(): Promise<SessionRow[]> {
  const { data, error } = await supabase
    .from('workout_sessions')
    .select('user_id, planned_date, completed_at, workout_type, energy_level, completed, is_recovery, created_at');
  return unwrap(data as SessionRow[] | null, error);
}

export async function fetchJournals(): Promise<JournalRow[]> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('user_id, date, created_at, user_text');
  return unwrap(data as JournalRow[] | null, error);
}

export async function fetchEvents(): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from('events')
    .select('id, user_id, event_name, created_at')
    .order('created_at', { ascending: false });
  return unwrap(data as EventRow[] | null, error);
}

export async function fetchExerciseLogs(): Promise<ExerciseLogRow[]> {
  const { data, error } = await supabase
    .from('exercise_logs')
    .select('user_id, exercise_name, weight_kg, logged_date, reps_in_reserve, is_recovery');
  return unwrap(data as ExerciseLogRow[] | null, error);
}

export async function fetchExerciseCatalog(): Promise<ExerciseCatalogRow[]> {
  const { data, error } = await supabase
    .from('exercises')
    .select('name, primary_muscle');
  return unwrap(data as ExerciseCatalogRow[] | null, error);
}

// ── Small presentation helpers shared across pages ───────────────────────────
export const SPLIT_META: Record<string, { label: string; color: string }> = {
  ppl:         { label: 'PPL',          color: '#87A96B' },
  upper_lower: { label: 'Upper/Lower',  color: '#60A5FA' },
  full_body:   { label: 'Full Body',    color: '#A78BFA' },
  bro_split:   { label: 'Bro Split',    color: '#F59E0B' },
};

export const GOAL_META: Record<string, { label: string; color: string }> = {
  build_muscle:    { label: 'Build Muscle',    color: '#87A96B' },
  lose_fat:        { label: 'Lose Fat',        color: '#60A5FA' },
  general_fitness: { label: 'General Fitness', color: '#A78BFA' },
  mobility:        { label: 'Mobility',        color: '#F59E0B' },
};

const FALLBACK_COLOR = '#EF4444';

// ── Revenue estimation (no billing table exists — everything here is an
//    ESTIMATE derived from analytics events and must be labeled as such) ──────
export const ESTIMATED_MONTHLY_PRICE_USD = 9.99;

/** Map event_name → set of distinct user_ids that fired it. */
export function distinctUsersByEvent(events: EventRow[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e.user_id) continue;
    const set = m.get(e.event_name) ?? new Set<string>();
    set.add(e.user_id);
    m.set(e.event_name, set);
  }
  return m;
}

/** Weekly count of an event over the trailing `weeks` weeks (oldest → newest). */
export function weeklyEventSeries(events: EventRow[], eventName: string, weeks = 12): Array<{ week: string; count: number }> {
  const now = new Date();
  const buckets: Array<{ start: Date; week: string; count: number }> = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(now);
    start.setDate(now.getDate() - i * 7);
    buckets.push({
      start,
      week: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: 0,
    });
  }
  const earliest = buckets[0].start.getTime();
  events
    .filter(e => e.event_name === eventName && e.created_at)
    .forEach(e => {
      const t = new Date(e.created_at).getTime();
      if (t < earliest) return;
      const idx = Math.min(buckets.length - 1, Math.floor((t - earliest) / (7 * 86400000)));
      if (idx >= 0) buckets[idx].count++;
    });
  return buckets.map(({ week, count }) => ({ week, count }));
}

/** Count rows by a string key and return chart-ready slices ordered by count. */
export function distribution(
  values: (string | null)[],
  meta: Record<string, { label: string; color: string }>,
) {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = values.length || 1;
  return Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      label: meta[key]?.label ?? key.replace(/_/g, ' '),
      color: meta[key]?.color ?? FALLBACK_COLOR,
      count,
      pct: parseFloat(((count / total) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.count - a.count);
}
