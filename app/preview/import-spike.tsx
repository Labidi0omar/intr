// Feasibility spike — workout-history import from another app.
//
// Goal: prove we can take a Hevy or Strong CSV export and map its exercise
// names onto our catalog (src/constants/exercises.ts) well enough to seed
// exercise_logs, and MEASURE the one number that decides whether this is
// worth building: name-match rate. Nothing here is wired into production.
//   • No Supabase reads or writes — the "dry run" table is computed and
//     rendered locally, never sent anywhere.
//   • No new dependency is imported. expo-document-picker (for a real
//     "pick a file" flow) is evaluated in the code comments below and in
//     the accompanying report, but NOT installed or imported — per the
//     task, that's a decision for explicit approval, not something a
//     spike assumes. In its place, this screen accepts CSV via paste
//     (a multiline TextInput) plus two "load sample export" buttons that
//     exercise the exact same parse → match → dry-run pipeline a real
//     picked file would.
//   • The fixture CSVs below are REPRESENTATIVE, hand-built from public
//     documentation of each app's export shape — not literal files
//     pulled from a live Hevy/Strong account (no such account was
//     available to this environment). Treat the match-rate numbers this
//     screen reports as a credible estimate on realistic data, not a
//     verified result against a specific user's real export. That
//     caveat is the single most important thing to re-validate before
//     treating this as a go decision.
//
// This file (and only this file) is the entire spike. When Phase 3 lands
// (or the feature is rejected), delete it — same lifecycle as the rest of
// app/preview/.

import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Button from '../../src/components/Button';
import { useTheme } from '../../src/context/ThemeContext';
import { layout, typography } from '../../src/theme';
import { PREVIEW_ENABLED } from '../../src/constants/previewFlags';
import PreviewHeader from '../../src/components/preview/PreviewHeader';
import PreviewSurface from '../../src/components/preview/PreviewSurface';
import { EXERCISES } from '../../src/constants/exercises';

// ────────────────────────────────────────────────────────────────────────
// ── 1. CSV parsing ────────────────────────────────────────────────────
//
// No csv-parse/papaparse dependency — the input is small (a workout
// history export, not a data warehouse) and a minimal RFC4180-ish parser
// (quoted fields, embedded commas, "" escaping) covers real exports fine.
// This is the same "small pure helper, no new dependency" bar the rest of
// this codebase holds (see anchorDerivation.ts's roundToPlate reuse).

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\r') { continue; }
    if (c === '\n') { pushRow(); continue; }
    field += c;
  }
  // Trailing field/row (files without a final newline).
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

// ── 2. Header-alias resolution ───────────────────────────────────────
//
// Real exports don't agree on header spelling even within "the same
// app" across versions/locales (Hevy: exercise_title vs Exercise Title;
// Strong: semicolon-delimited in some locales, Weight without a unit
// suffix). A fixed column-index parser would be brittle to the FIRST
// header-name drift; resolving by alias is the actual robustness bar for
// a real importer, not just this spike.

type FieldKey = 'date' | 'workoutName' | 'exerciseName' | 'setOrder' | 'weight' | 'reps' | 'rpe';

const HEADER_ALIASES: Record<FieldKey, string[]> = {
  date: ['date', 'start_time', 'workout date', 'start date'],
  workoutName: ['workout name', 'title', 'workout_title', 'workout'],
  exerciseName: ['exercise name', 'exercise_title', 'exercise'],
  setOrder: ['set order', 'set_index', 'set number', 'set'],
  weight: ['weight', 'weight_kg', 'weight (kg)', 'weight_lbs', 'weight (lb)'],
  reps: ['reps', 'rep count'],
  rpe: ['rpe'],
};

function resolveHeaderIndex(headers: string[], key: FieldKey): number {
  const normalized = headers.map(h => h.trim().toLowerCase());
  for (const alias of HEADER_ALIASES[key]) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** True if the header row's weight column is a `_lbs`/`(lb)` variant —
 *  the ONE real unit hazard in this whole pipeline. Strong's actual
 *  export gives no unit at all in the header (it follows the user's
 *  in-app setting), which this heuristic can't see — flagged in the
 *  report, not solved here. */
function weightColumnIsPounds(headers: string[]): boolean {
  const h = headers.map(x => x.trim().toLowerCase());
  return h.some(x => x === 'weight_lbs' || x === 'weight (lb)');
}

export interface ImportedSetRow {
  date: string; // YYYY-MM-DD
  workoutName: string;
  exerciseName: string; // raw, as typed in the source app
  setOrder: number;
  weightKg: number;
  reps: number;
  rpe: number | null;
}

/** Parses a CSV (Hevy or Strong shape — resolved per-column by alias, not
 *  by a hardcoded per-app column order) into flat set rows. Rows missing
 *  a required field (date/exercise/weight/reps) are skipped and counted
 *  as `skipped` so the caller can report data-quality issues separately
 *  from name-match issues — those are two different failure modes and
 *  conflating them would hide which one actually blocks the feature. */
export function parseWorkoutCsv(csvText: string): { rows: ImportedSetRow[]; skipped: number } {
  const table = parseCsv(csvText.trim());
  if (table.length < 2) return { rows: [], skipped: 0 };

  const headers = table[0];
  const iDate = resolveHeaderIndex(headers, 'date');
  const iWorkout = resolveHeaderIndex(headers, 'workoutName');
  const iExercise = resolveHeaderIndex(headers, 'exerciseName');
  const iSetOrder = resolveHeaderIndex(headers, 'setOrder');
  const iWeight = resolveHeaderIndex(headers, 'weight');
  const iReps = resolveHeaderIndex(headers, 'reps');
  const iRpe = resolveHeaderIndex(headers, 'rpe');
  const lbToKg = weightColumnIsPounds(headers);

  const rows: ImportedSetRow[] = [];
  let skipped = 0;

  for (let r = 1; r < table.length; r++) {
    const cols = table[r];
    const dateRaw = iDate !== -1 ? cols[iDate] : '';
    const exerciseName = iExercise !== -1 ? cols[iExercise]?.trim() : '';
    const weightRaw = iWeight !== -1 ? cols[iWeight] : '';
    const repsRaw = iReps !== -1 ? cols[iReps] : '';

    const date = (dateRaw ?? '').trim().slice(0, 10); // "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD"
    const weightNum = Number(weightRaw);
    const repsNum = Number(repsRaw);

    if (!date || !exerciseName || !Number.isFinite(weightNum) || weightNum <= 0 || !Number.isFinite(repsNum) || repsNum <= 0) {
      skipped++;
      continue;
    }

    const rpeRaw = iRpe !== -1 ? cols[iRpe] : '';
    const rpeNum = Number(rpeRaw);

    rows.push({
      date,
      workoutName: (iWorkout !== -1 ? cols[iWorkout] : '') ?? '',
      exerciseName,
      setOrder: iSetOrder !== -1 ? (Number(cols[iSetOrder]) || 0) : 0,
      weightKg: lbToKg ? Math.round(weightNum * 0.45359237 * 100) / 100 : weightNum,
      reps: repsNum,
      rpe: Number.isFinite(rpeNum) && rpeRaw?.trim() !== '' ? rpeNum : null,
    });
  }

  return { rows, skipped };
}

// ── 3. Exercise-name matching ─────────────────────────────────────────
//
// Normalize + token-overlap scoring — deliberately NOT a Levenshtein/
// edit-distance library (no new dependency, and the dominant real-world
// failure mode is word REORDERING / equipment annotation, not typos:
// "Bench Press (Barbell)" vs "Barbell Bench Press" share every token but
// aren't a short edit distance apart). A Dice-coefficient on token sets
// handles that directly; a small containment bonus catches the "your
// name is a strict subset of the catalog name" case (e.g. "Deadlift" vs
// a hypothetical "Deadlift (Barbell)").

function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter(Boolean));
}

function diceScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return (2 * overlap) / (a.size + b.size);
}

interface CatalogMatchCandidate {
  name: string;
  score: number;
}

export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface MatchResult {
  importedName: string;
  status: MatchStatus;
  /** Best candidate first. Empty for 'unmatched'. */
  candidates: CatalogMatchCandidate[];
}

// Thresholds are the spike's one real judgment call — tuned by hand
// against the sample fixtures below, not derived from a formula. Flag
// for recalibration once tested against a real export (see report).
const CLEAN_MATCH_MIN_SCORE = 0.72;
const CLEAN_MATCH_MIN_LEAD = 0.12; // must beat the #2 candidate by this much
const AMBIGUOUS_MIN_SCORE = 0.45;

// Bodyweight-equipment catalog entries are EXCLUDED from the candidate
// pool entirely. Found via a real test run, not hypothesized: a plain
// "Bicep Curl" import (15kg logged) was matching cleanly to "Towel Bicep
// Curl" (a bodyweight home exercise) at 95% confidence, because the
// token/containment scorer has no concept of equipment — it just saw
// "bicep curl" as a substring of "towel bicep curl" and rewarded the
// containment. A row with a real logged weight can never correctly map
// to a bodyweight movement (the app's own Coach's Call suppresses
// bodyweight equipment from every weight-based flow — shouldShowCoachCall
// in src/lib/coachCall.ts), so excluding that whole equipment class from
// consideration is a correctness fix, not a heuristic tweak. See the
// report for the "Bulgarian Split Squat (Dumbbell)" case this same fix
// surfaces as a genuine catalog gap rather than a false match.
const CATALOG_NORMALIZED = EXERCISES
  .filter(e => e.equipment !== 'bodyweight')
  .map(e => ({ name: e.name, tokens: tokenSet(normalizeForMatch(e.name)), normalized: normalizeForMatch(e.name) }));

export function matchExerciseName(importedName: string): MatchResult {
  const normalized = normalizeForMatch(importedName);
  const importedTokens = tokenSet(normalized);

  const scored = CATALOG_NORMALIZED.map(entry => {
    let score = diceScore(importedTokens, entry.tokens);
    if (normalized === entry.normalized) score = 1;
    else if (entry.normalized.includes(normalized) || normalized.includes(entry.normalized)) {
      score = Math.min(0.99, score + 0.15);
    }
    return { name: entry.name, score };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];

  if (!top || top.score < AMBIGUOUS_MIN_SCORE) {
    return { importedName, status: 'unmatched', candidates: [] };
  }

  const candidates = scored.filter(c => c.score >= AMBIGUOUS_MIN_SCORE).slice(0, 4);

  const isClean = top.score >= CLEAN_MATCH_MIN_SCORE && (!second || top.score - second.score >= CLEAN_MATCH_MIN_LEAD);
  return { importedName, status: isClean ? 'matched' : 'ambiguous', candidates };
}

// ── 4. Dry-run exercise_logs rows ─────────────────────────────────────
//
// Matches the app's ACTUAL data model, not a naive "one row per set":
// exercise_logs is one row per (user, exercise, day) representing that
// day's working set — see finishWorkout's logRows in app/workout.tsx,
// which logs the single committed weight per exercise, not a full set
// log. Importing every individual set as its own row would silently
// violate that invariant (multiple same-day rows per exercise) and
// corrupt "last weight" reads downstream. This groups by (date, mapped
// exercise) and keeps the heaviest set of the day — the same "working
// set" semantics prescribeLoad already assumes.

export interface DryRunLogRow {
  exercise_name: string;
  weight_kg: number;
  reps_in_reserve: number | null;
  logged_date: string;
  is_recovery: false;
  /** Spike-only provenance, not part of the real exercise_logs shape —
   *  shown in the UI so a reviewer can see which raw import name/row
   *  produced this dry-run row. */
  _sourceName: string;
}

/** RPE -> RIR: RPE 10 (failure) = 0 RIR, RPE 9 = 1 RIR, … — the standard
 *  inverse relationship, clamped to this app's existing 0-5 check
 *  constraint (see 20260530000000_exercise_logs_rir.sql). */
function rpeToRir(rpe: number | null): number | null {
  if (rpe == null) return null;
  const rir = Math.round(10 - rpe);
  return Math.max(0, Math.min(5, rir));
}

export function buildDryRun(rows: ImportedSetRow[], matches: Map<string, MatchResult>): DryRunLogRow[] {
  // Group by (date, mapped catalog name); keep the heaviest set per group.
  const groups = new Map<string, { row: ImportedSetRow; catalogName: string }>();
  for (const row of rows) {
    const match = matches.get(row.exerciseName);
    if (!match || match.status !== 'matched') continue; // dry-run only shows what WOULD import cleanly today
    const catalogName = match.candidates[0].name;
    const key = `${row.date}|${catalogName}`;
    const existing = groups.get(key);
    if (!existing || row.weightKg > existing.row.weightKg) {
      groups.set(key, { row, catalogName });
    }
  }

  return Array.from(groups.values())
    .map(({ row, catalogName }) => ({
      exercise_name: catalogName,
      weight_kg: row.weightKg,
      reps_in_reserve: rpeToRir(row.rpe),
      logged_date: row.date,
      is_recovery: false as const,
      _sourceName: row.exerciseName,
    }))
    .sort((a, b) => (a.logged_date < b.logged_date ? -1 : a.logged_date > b.logged_date ? 1 : 0));
}

// ── 5. Representative sample fixtures ─────────────────────────────────
// See the file-header caveat: hand-built from each app's documented
// export shape, not pulled from a real account. Deliberately include
// clean matches, ambiguous generic names, and exercises we don't
// catalog at all, in roughly the proportions a real history would have.

const SAMPLE_HEVY_CSV = `title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Bench Press (Barbell),,,0,normal,60,8,,,7
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Bench Press (Barbell),,,1,normal,60,7,,,8
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Bench Press (Barbell),,,2,normal,62.5,6,,,9
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Incline Bench Press (Dumbbell),,,0,normal,20,10,,,7
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Incline Bench Press (Dumbbell),,,1,normal,22.5,9,,,8
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Shoulder Press (Dumbbell),,,0,normal,17.5,10,,,7
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Lateral Raise (Dumbbell),,,0,normal,7.5,15,,,8
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Tricep Pushdown (Cable),,,0,normal,25,12,,,7
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Chest Fly (Cable),,,0,normal,15,12,,,7
Push Day,2026-06-01 08:00:00,2026-06-01 09:05:00,,Overhead Tricep Extention (Dumbbell),,,0,normal,12.5,12,,,7
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Deadlift (Barbell),,,0,normal,100,5,,,8
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Deadlift (Barbell),,,1,normal,110,4,,,9
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Lat Pulldown (Cable),,,0,normal,45,10,,,7
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Seated Cable Row,,,0,normal,55,10,,,7
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Face Pull (Cable),,,0,normal,15,15,,,6
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Bicep Curl (Barbell),,,0,normal,25,10,,,7
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Dumbell Row (Dumbbell),,,0,normal,30,10,,,7
Pull Day,2026-06-03 08:00:00,2026-06-03 09:10:00,,Row,,,0,normal,50,10,,,7
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Squat (Barbell),,,0,normal,90,6,,,8
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Squat (Barbell),,,1,normal,95,5,,,9
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Leg Press (Machine),,,0,normal,180,10,,,7
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Leg Curl (Machine),,,0,normal,35,12,,,7
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Hip Thrust (Barbell),,,0,normal,140,8,,,7
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Romanian Deadlift (Barbell),,,0,normal,80,8,,,7
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Bulgarian Split Squat (Dumbbell),,,0,normal,16,10,,,7
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Sled Push,,,0,normal,80,1,20,,
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Farmer's Carry,,,0,normal,32,1,,40,
Leg Day,2026-06-05 08:00:00,2026-06-05 09:15:00,,Hip Abduction (Machine),,,0,normal,40,15,,,6`;

const SAMPLE_STRONG_CSV = `Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
2026-06-02,Upper A,55,Bench Press,1,60,8,,,,,
2026-06-02,Upper A,55,Bench Press,2,62.5,6,,,,,
2026-06-02,Upper A,55,Overhead Press,1,35,8,,,,,
2026-06-02,Upper A,55,Barbell Row,1,55,8,,,,,
2026-06-02,Upper A,55,Barbell Row,2,57.5,7,,,,,
2026-06-02,Upper A,55,Lateral Raise,1,7.5,15,,,,,
2026-06-02,Upper A,55,Tricep Extension,1,12.5,12,,,,,
2026-06-02,Upper A,55,Bicep Curl,1,15,10,,,,,
2026-06-02,Upper A,55,Face Pull,1,12.5,15,,,,,
2026-06-04,Lower A,60,Squat,1,90,6,,,,,
2026-06-04,Lower A,60,Squat,2,95,5,,,,,
2026-06-04,Lower A,60,Romanian Deadlift,1,80,8,,,,,
2026-06-04,Lower A,60,Leg Press,1,180,10,,,,,
2026-06-04,Lower A,60,Leg Extension,1,35,12,,,,,
2026-06-04,Lower A,60,Leg Curl,1,35,12,,,,,
2026-06-04,Lower A,60,Calf Raise,1,60,15,,,,,
2026-06-04,Lower A,60,Hip Thrust,1,140,8,,,,,
2026-06-04,Lower A,60,Farmer's Walk,1,32,1,20,,,,
2026-06-06,Upper B,50,Incline Dumbbell Press,1,20,10,,,,,
2026-06-06,Upper B,50,Incline Dumbbell Press,2,22.5,8,,,,,
2026-06-06,Upper B,50,Seated Row,1,55,10,,,,,
2026-06-06,Upper B,50,Lat Pulldown,1,45,10,,,,,
2026-06-06,Upper B,50,Dumbbell Shoulder Press,1,17.5,10,,,,,
2026-06-06,Upper B,50,Cable Curl,1,20,10,,,,,
2026-06-06,Upper B,50,Skullcrusher,1,17.5,10,,,,,
2026-06-06,Upper B,50,Box Jump,1,,10,,,,,
2026-06-06,Upper B,50,Battle Ropes,1,,1,,30,,,`;

// ────────────────────────────────────────────────────────────────────────

export default function ImportSpikeScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const styles = makeStyles(colors);

  const [csvText, setCsvText] = useState('');
  const [source, setSource] = useState<'hevy' | 'strong' | null>(null);

  // Hooks must run unconditionally (same order every render) — the
  // dev-gate early return sits AFTER every hook, not before, even though
  // its output is thrown away in a disabled build. Matches the pattern
  // every other app/preview/* screen uses.
  const parsed = useMemo(() => parseWorkoutCsv(csvText), [csvText]);

  const uniqueNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of parsed.rows) seen.set(r.exerciseName, (seen.get(r.exerciseName) ?? 0) + 1);
    return seen;
  }, [parsed.rows]);

  const matches = useMemo(() => {
    const m = new Map<string, MatchResult>();
    for (const name of uniqueNames.keys()) m.set(name, matchExerciseName(name));
    return m;
  }, [uniqueNames]);

  const buckets = useMemo(() => {
    const matched: MatchResult[] = [];
    const ambiguous: MatchResult[] = [];
    const unmatched: MatchResult[] = [];
    for (const m of matches.values()) {
      if (m.status === 'matched') matched.push(m);
      else if (m.status === 'ambiguous') ambiguous.push(m);
      else unmatched.push(m);
    }
    return { matched, ambiguous, unmatched };
  }, [matches]);

  const dryRun = useMemo(() => buildDryRun(parsed.rows, matches), [parsed.rows, matches]);

  if (!__DEV__ || !PREVIEW_ENABLED) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.notAvailable}>
          <Text style={styles.notAvailableText}>Not available in this build.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const totalUnique = uniqueNames.size;
  const pct = (n: number) => (totalUnique === 0 ? '—' : `${Math.round((n / totalUnique) * 100)}%`);

  const loadSample = (which: 'hevy' | 'strong') => {
    setCsvText(which === 'hevy' ? SAMPLE_HEVY_CSV : SAMPLE_STRONG_CSV);
    setSource(which);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <PreviewHeader
        eyebrow="FEASIBILITY SPIKE"
        title="Import Match Rate"
        onBack={() => router.back()}
        divider
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          Paste a Hevy or Strong CSV export (or load a representative sample below) to
          measure exercise-name match rate against the catalog. Nothing here writes to
          the database — this is read-only, in-memory analysis.
        </Text>

        <View style={styles.sampleRow}>
          <TouchableOpacity style={styles.sampleBtn} onPress={() => loadSample('hevy')} activeOpacity={0.7}>
            <Text style={styles.sampleBtnText}>Load sample Hevy export</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sampleBtn} onPress={() => loadSample('strong')} activeOpacity={0.7}>
            <Text style={styles.sampleBtnText}>Load sample Strong export</Text>
          </TouchableOpacity>
        </View>
        {source ? (
          <Text style={styles.sourceLabel}>Loaded: {source === 'hevy' ? 'Hevy' : 'Strong'} sample</Text>
        ) : null}

        <TextInput
          style={styles.csvInput}
          value={csvText}
          onChangeText={text => { setCsvText(text); setSource(null); }}
          placeholder="Paste CSV export here…"
          placeholderTextColor={colors.textMuted}
          multiline
          numberOfLines={8}
          textAlignVertical="top"
        />

        {csvText.trim() === '' ? null : (
          <>
            <PreviewSurface>
              <Text style={styles.sectionTitle}>Summary</Text>
              <Text style={styles.summaryLine}>
                {parsed.rows.length} sets parsed{parsed.skipped > 0 ? `, ${parsed.skipped} rows skipped (missing/invalid fields)` : ''} · {totalUnique} unique exercise names
              </Text>
              <View style={styles.statRow}>
                <View style={styles.statCell}>
                  <Text style={[styles.statValue, { color: colors.accentPositive }]}>{buckets.matched.length}</Text>
                  <Text style={styles.statLabel}>MATCHED ({pct(buckets.matched.length)})</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={[styles.statValue, { color: colors.accentAmber }]}>{buckets.ambiguous.length}</Text>
                  <Text style={styles.statLabel}>AMBIGUOUS ({pct(buckets.ambiguous.length)})</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={[styles.statValue, { color: colors.accentRed }]}>{buckets.unmatched.length}</Text>
                  <Text style={styles.statLabel}>UNMATCHED ({pct(buckets.unmatched.length)})</Text>
                </View>
              </View>
              <Text style={styles.rowCoverageLine}>
                Row coverage (sets belonging to a cleanly-matched name): {' '}
                {parsed.rows.filter(r => matches.get(r.exerciseName)?.status === 'matched').length} / {parsed.rows.length}
              </Text>
            </PreviewSurface>

            <PreviewSurface>
              <Text style={styles.sectionTitle}>Matched ({buckets.matched.length})</Text>
              {buckets.matched.map(m => (
                <Text key={m.importedName} style={styles.matchLine}>
                  <Text style={{ color: colors.textPrimary }}>{m.importedName}</Text>
                  <Text style={{ color: colors.textMuted }}> → </Text>
                  <Text style={{ color: colors.accentPositive }}>{m.candidates[0].name}</Text>
                  <Text style={{ color: colors.textMuted }}> ({Math.round(m.candidates[0].score * 100)}%)</Text>
                </Text>
              ))}
            </PreviewSurface>

            <PreviewSurface tone={colors.accentAmber}>
              <Text style={styles.sectionTitle}>Ambiguous ({buckets.ambiguous.length})</Text>
              {buckets.ambiguous.length === 0 ? (
                <Text style={styles.emptyLine}>None.</Text>
              ) : buckets.ambiguous.map(m => (
                <View key={m.importedName} style={{ marginBottom: layout.spacing.sm }}>
                  <Text style={[styles.matchLine, { color: colors.textPrimary }]}>{m.importedName}</Text>
                  <Text style={styles.candidateLine}>
                    candidates: {m.candidates.map(c => `${c.name} (${Math.round(c.score * 100)}%)`).join(', ')}
                  </Text>
                </View>
              ))}
            </PreviewSurface>

            <PreviewSurface tone={colors.accentRed}>
              <Text style={styles.sectionTitle}>Unmatched ({buckets.unmatched.length})</Text>
              {buckets.unmatched.length === 0 ? (
                <Text style={styles.emptyLine}>None.</Text>
              ) : buckets.unmatched.map(m => (
                <Text key={m.importedName} style={[styles.matchLine, { color: colors.textPrimary }]}>{m.importedName}</Text>
              ))}
            </PreviewSurface>

            <PreviewSurface>
              <Text style={styles.sectionTitle}>Dry-run exercise_logs rows ({dryRun.length})</Text>
              <Text style={styles.dryRunCaveat}>
                Read-only preview — nothing below is written to Supabase. Only
                cleanly-MATCHED names produce a row; ambiguous/unmatched names are
                withheld pending a &quot;map this exercise&quot; resolution (see report).
              </Text>
              {dryRun.slice(0, 12).map((r, i) => (
                <Text key={i} style={styles.dryRunLine}>
                  {r.logged_date} · {r.exercise_name} · {r.weight_kg}kg · RIR {r.reps_in_reserve ?? '—'} · is_recovery=false
                </Text>
              ))}
              {dryRun.length > 12 ? (
                <Text style={styles.emptyLine}>…and {dryRun.length - 12} more.</Text>
              ) : null}
            </PreviewSurface>
          </>
        )}

        <Button title="Back" variant="secondary" onPress={() => router.back()} style={{ marginTop: layout.spacing.lg }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.background },
    notAvailable: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: layout.spacing.lg },
    notAvailableText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.md,
      color: colors.textMuted,
    },
    content: { padding: layout.spacing.lg, paddingBottom: layout.spacing.xxl },
    intro: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      lineHeight: 20,
      marginBottom: layout.spacing.md,
    },
    sampleRow: { flexDirection: 'row', gap: 8, marginBottom: layout.spacing.sm },
    sampleBtn: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      alignItems: 'center',
    },
    sampleBtnText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s12,
      color: colors.textSecondary,
    },
    sourceLabel: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      color: colors.accentTeal,
      marginBottom: layout.spacing.sm,
    },
    csvInput: {
      minHeight: 120,
      maxHeight: 220,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      fontFamily: typography.family.body,
      fontSize: typography.size.xs,
      padding: layout.spacing.sm,
      marginBottom: layout.spacing.md,
    },
    sectionTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.md,
      color: colors.textPrimary,
      marginBottom: layout.spacing.sm,
    },
    summaryLine: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      color: colors.textSecondary,
      marginBottom: layout.spacing.sm,
    },
    statRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: layout.spacing.sm },
    statCell: { alignItems: 'center' },
    statValue: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xl,
    },
    statLabel: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s9_5,
      color: colors.textMuted,
      letterSpacing: 1,
      marginTop: 2,
    },
    rowCoverageLine: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      color: colors.textMuted,
    },
    matchLine: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      lineHeight: 19,
    },
    candidateLine: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s10_5,
      color: colors.textMuted,
      marginTop: 1,
    },
    emptyLine: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      color: colors.textMuted,
      fontStyle: 'italic',
    },
    dryRunCaveat: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s10_5,
      color: colors.textMuted,
      marginBottom: layout.spacing.sm,
      lineHeight: 15,
    },
    dryRunLine: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      color: colors.textSecondary,
      lineHeight: 18,
    },
  });
