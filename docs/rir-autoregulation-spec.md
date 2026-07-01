# RIR Capture + RIR-Driven Load Prescription — Implementation Spec

**Goal:** Turn Intr's open-loop "energy 1–5" replanner into a closed-loop autoregulation engine
backed by Reps-in-Reserve (RIR), the most-studied autoregulation signal (Zourdos 2016). This is the
first shippable slice of the differentiator: capture in-set effort, prescribe next load from it, and
narrate the adaptation.

**Scope of THIS spec (the first slice — ship before anything else):**
1. Schema: add `reps_in_reserve` to `exercise_logs`.
2. `workout.tsx`: capture RIR with one tap in the existing weight overlay; persist it.
3. New pure module `src/lib/loadPrescription.ts`: RIR → next-session load.
4. `safety.ts`: replace the flat 60–105% clamp with the RIR-aware band.
5. Wire suggested load into the pre-screen and the replanner output.

**Explicitly OUT of scope here** (later slices, do not build yet): HRV/sleep wearables, readiness
composite, volume landmarks/auto-deload. Sequence matters — validate this loop first.

---

## 1. Schema migration

New file: `supabase/migrations/20260530000000_exercise_logs_rir.sql`

```sql
-- Capture reps-in-reserve per logged exercise. Nullable: legacy rows and
-- skipped logs have no RIR. smallint 0..5 (5 = "5+ reps left / very easy").
alter table public.exercise_logs
  add column if not exists reps_in_reserve smallint;

-- Optional sanity bound. Keep it loose; the client clamps to 0..5 anyway.
alter table public.exercise_logs
  drop constraint if exists exercise_logs_rir_range;
alter table public.exercise_logs
  add constraint exercise_logs_rir_range
  check (reps_in_reserve is null or (reps_in_reserve >= 0 and reps_in_reserve <= 5));

-- The load-prescription query reads the most recent log per (user, exercise):
--   select weight_kg, reps_in_reserve, logged_date
--   from exercise_logs
--   where user_id = X and exercise_name = ANY(...)
--   order by logged_date desc
-- Add the covering index if it isn't already present.
create index if not exists exercise_logs_user_exercise_date_idx
  on public.exercise_logs (user_id, exercise_name, logged_date desc);
```

RLS already covers `exercise_logs` (per-user policies in the baseline migration); a new column
inherits them. No policy change needed.

---

## 2. `workout.tsx` — capture RIR in the weight overlay

The overlay already interrupts the user per exercise (`weightPhaseForEx`, lines ~1025–1166), so RIR
costs the user one extra tap, not a new screen. RIR semantics shown to the user in plain words:

| Chip | RIR value | Meaning |
|------|-----------|---------|
| Failed | 0 | Couldn't finish the last rep |
| Hard | 1 | ~1 rep left |
| Solid | 2 | ~2 reps left (the target zone) |
| Easy | 3+ | 3 or more left in the tank |

### 2a. State

Add alongside `weightLog` (line ~132):

```ts
// exercise name -> reps-in-reserve (0..5). Parallel to weightLog.
const [rirLog, setRirLog] = useState<Record<string, number>>({});
```

### 2b. UI — RIR chip row inside the weighted branch

Insert directly **above** the "Log · Continue" button (currently line ~1151). Render only for the
weighted branch; bodyweight can reuse the same row but it's optional for v1.

```tsx
<Text style={[styles.weightLabel, { color: colors.textMuted, marginTop: layout.spacing.md }]}>
  HOW HARD WAS THAT SET?
</Text>
<View style={styles.rirRow}>
  {([
    { label: 'Failed', rir: 0 },
    { label: 'Hard',   rir: 1 },
    { label: 'Solid',  rir: 2 },
    { label: 'Easy',   rir: 3 },
  ] as const).map(opt => {
    const selected = rirLog[exName] === opt.rir;
    return (
      <TouchableOpacity
        key={opt.rir}
        style={[styles.rirChip, selected && styles.rirChipActive]}
        onPress={() => setRirLog(prev => ({ ...prev, [exName]: opt.rir }))}
        activeOpacity={0.7}
      >
        <Text style={[styles.rirChipText, selected && { color: colors.accentTeal }]}>
          {opt.label}
        </Text>
      </TouchableOpacity>
    );
  })}
</View>
```

RIR is **optional** — never block "Log · Continue" on it. A skipped RIR just means that exercise
won't drive a prescription next time (falls back to the current weight-only behavior).

### 2c. Persist RIR in `finishWorkout`

In `finishWorkout` (line ~452), the `logRows` builder (lines ~516–524) maps `weightLog` → rows. Add
`reps_in_reserve`:

```ts
const logRows = Object.entries(weightLog)
  .filter(([, w]) => w && !isNaN(parseFloat(w)))
  .map(([exerciseName, w]) => ({
    user_id: user.id,
    exercise_name: exerciseName,
    weight_kg: parseFloat(w),
    logged_date: logDate,
    session_id: sessionId,
    reps_in_reserve: rirLog[exerciseName] ?? null,   // <-- new
  }));
```

### 2d. Load RIR alongside history in `fetchTodayPlan`

The pre-load query (lines ~240–245) already selects `exercise_logs`. Add `reps_in_reserve` to the
`select` and carry it into `lastWeights` so the prescription helper can use it:

```ts
const { data: logs } = await supabase
  .from('exercise_logs')
  .select('exercise_name, weight_kg, logged_date, reps_in_reserve')  // <-- add column
  .eq('user_id', user.id)
  .in('exercise_name', exerciseNames)
  .order('logged_date', { ascending: false });
```

Extend the `latest` accumulator (line ~248) to keep `rir`:

```ts
const latest: Record<string, { weight: number; date: string; rir: number | null }> = {};
// ...
latest[row.exercise_name] = { weight: row.weight_kg, date: row.logged_date, rir: row.reps_in_reserve ?? null };
```

(Update the `lastWeights` state type accordingly.)

### 2e. Styles

Add to `makeStyles`:

```ts
rirRow: { flexDirection: 'row', gap: 8, marginTop: layout.spacing.sm, marginBottom: layout.spacing.sm },
rirChip: {
  flex: 1, paddingVertical: 8, borderRadius: layout.smRadius,
  borderWidth: 1, borderColor: colors.cardBorder, alignItems: 'center',
},
rirChipActive: { borderColor: colors.accentTeal, backgroundColor: colors.surfaceElevated },
rirChipText: { fontFamily: typography.family.bodyMedium, fontSize: 11, color: colors.textMuted, letterSpacing: 0.5 },
```

---

## 3. New module: `src/lib/loadPrescription.ts`

This is the engine. Pure, deterministic, unit-testable, **no LLM**. Implements APRE-style load
progression (the top-ranked autoregulation method in the 2025 network meta-analysis).

```ts
// Deterministic next-session load prescription from last session's RIR.
// APRE-style: if you left reps in reserve, go up; if you hit failure, hold/back off.
// Readiness (today's energy) only nudges the result — it never overrides the RIR signal.

export interface PrescriptionInput {
  lastWeightKg: number;        // most recent logged weight for this exercise
  lastRir: number | null;      // most recent RIR (0..5), or null if unknown
  energyScore: number;         // today's 1..5
  isCompound: boolean;         // bigger jumps allowed on compounds
}

export interface Prescription {
  suggestedWeightKg: number;
  deltaPct: number;            // for analytics / "coach was right" tracking
  rationale: 'progress' | 'hold' | 'backoff' | 'no_history';
}

// Round to the nearest loadable increment (2.5 kg default plate math).
function roundToPlate(kg: number, step = 2.5): number {
  return Math.max(step, Math.round(kg / step) * step);
}

export function prescribeLoad(input: PrescriptionInput): Prescription {
  const { lastWeightKg, lastRir, energyScore, isCompound } = input;

  if (!lastWeightKg || lastWeightKg <= 0) {
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'no_history' };
  }
  if (lastRir === null) {
    // No effort signal -> repeat last load, let RIR accrue next time.
    return { suggestedWeightKg: lastWeightKg, deltaPct: 0, rationale: 'hold' };
  }

  // Base step from RIR. Compounds tolerate larger jumps than isolations.
  const up = isCompound ? 0.05 : 0.025;   // +5% compound / +2.5% isolation
  let deltaPct: number;
  let rationale: Prescription['rationale'];

  if (lastRir >= 3)      { deltaPct = up;        rationale = 'progress'; } // too easy -> climb
  else if (lastRir === 2){ deltaPct = up / 2;    rationale = 'progress'; } // target zone -> small bump
  else if (lastRir === 1){ deltaPct = 0;         rationale = 'hold'; }     // hard -> repeat
  else                   { deltaPct = -0.05;     rationale = 'backoff'; }  // failure -> back off 5%

  // Readiness modifier: only pulls DOWN on bad days, never inflates on good ones.
  // (Energy is a noisy self-report; let it protect, not push.)
  if (energyScore <= 2 && deltaPct > 0) deltaPct = 0;          // low energy cancels a planned increase
  if (energyScore <= 2 && rationale === 'hold') deltaPct = -0.05; // and lightens a hold slightly

  const raw = lastWeightKg * (1 + deltaPct);
  return {
    suggestedWeightKg: roundToPlate(raw),
    deltaPct,
    rationale,
  };
}
```

Compound classification already exists in `planGeneration.ts` (`classifyCompoundness`). Export a
boolean helper from there (`isCompoundName(name): boolean => classifyCompoundness(name) >= 7`) and
reuse it — do not duplicate the keyword lists.

---

## 4. `safety.ts` — RIR-aware clamp on the edge function

Today `applyReplanSafety` (lines ~98–112) clamps `suggestedWeightKg` to a flat 60–105% of last
logged. That's a guardrail, not a prescription, and it discards the RIR signal. Two changes:

1. **Extend `SafetyContext`** to carry last RIR per exercise:

```ts
export interface SafetyContext {
  original: PlanDay;
  lastWeights: Record<string, number>;
  lastRir?: Record<string, number | null>;   // <-- new, optional
}
```

2. **Replace the flat band** (lines ~99–111) with: prescribe from RIR, then clamp the LLM's number
to within ±1 plate of the prescription so the model can't override the math:

```ts
const last = ctx.lastWeights[orig.name];
if (typeof last === 'number' && last > 0) {
  const rx = prescribeLoad({
    lastWeightKg: last,
    lastRir: ctx.lastRir?.[orig.name] ?? null,
    energyScore: ctx.energyScore,      // pass energy_score through into SafetyContext too
    isCompound: isCompoundName(orig.name),
  });
  // The prescription is the source of truth. Let the LLM nudge within one plate.
  const lo = rx.suggestedWeightKg - 2.5;
  const hi = rx.suggestedWeightKg + 2.5;
  const llm = typeof ex.suggestedWeightKg === 'number' ? ex.suggestedWeightKg : rx.suggestedWeightKg;
  weight = Math.round(Math.max(lo, Math.min(llm, hi)) / 2.5) * 2.5;
} else {
  weight = Math.max(5, Math.min(ex.suggestedWeightKg ?? 0, 250)) || undefined;
}
```

This is the key architectural correction from the audit: **the arithmetic moves out of the LLM and
into deterministic code.** Claude keeps doing what it's good at — the `reasoning` line and which
accessory to drop — while load is computed, bounded, and cheap.

3. In `replan-today/index.ts`, the context fetch (lines ~177–196) already pulls `exercise_logs`. Add
`reps_in_reserve` to that select, build a `lastRir` map next to `lastWeights` (lines ~199–206), and
pass both `lastRir` and `energyScore` into `applyReplanSafety`'s context (line ~263).

---

## 5. Surface the prescription (pre-screen + active set)

The win must be **visible** or it won't retain. Two cheap surfaces:

- **Pre-screen coach hint** (`coachHints`, lines ~159–168): when a prescription exists, show
  `"Last set felt easy — try ${suggestedWeightKg}kg"` (rationale `progress`) or
  `"You hit failure last time — hold at ${last}kg"` (rationale `backoff`).
- **Weight overlay pre-fill**: in `handleNextExercise` (line ~412) you already pre-fill with last
  weight. Pre-fill with `prescribeLoad(...).suggestedWeightKg` instead, and label the "same" pill
  area with the rationale ("+2.5 — last set had reps left").

This closes the loop the user can *see*: effort in → load out → narrated reason.

---

## 6. Sequencing & verification

**Build order (each independently shippable):**
1. Migration + `loadPrescription.ts` + unit tests (no UI risk).
2. RIR capture UI + persistence in `workout.tsx`. Ship; start collecting RIR data.
3. Pre-screen/overlay prescription surfacing (client-only; works without the edge function).
4. `safety.ts` + `replan-today` wiring (moves load math server-side for the AI path).

**Verification (there is no test suite today — add one for the pure module):**
- Unit-test `prescribeLoad` against a table: `(lastWeight, lastRir, energy, isCompound) → expected`.
  Cover RIR 0/1/2/3, energy ≤2 down-modifier, null RIR, zero/no history, plate rounding.
- `npx tsc --noEmit` after each step (the project's stated correctness gate).
- Manual: log a set at "Easy" → next session pre-fill should be higher; log "Failed" → next should
  back off; set energy to 2 → a planned increase should cancel.

**Analytics to add** (you already have `track()` and the `metrics_cohorts` view): emit
`prescription_shown` with `{ rationale, deltaPct }` and `prescription_followed` when the user logs at
or near the suggested weight. That's the data behind the eventual "the coach was right N of your last
M sessions" retention hook — and it tells you whether the engine actually works before you build the
heavier slices (wearables, volume landmarks).

---

## One risk to watch

RIR self-reports are noisy for beginners — novices systematically under-rate effort (think they have
2 left when they have 5). Mitigation: keep increments conservative for `fitnessLevel: 'beginner'`
(halve the `up` step), and lean on the energy down-modifier as a safety net. Don't over-trust a
beginner's RIR; the loop gets more accurate as the user calibrates, which is itself a reason to stay.
