// Recovery / prehab content library.
//
// Strictly separate from src/constants/exercises.ts. These items are NEVER
// surfaced inside the load-progression coach, the RIR autoregulator, the
// mesocycle planner, or PR detection. They exist only for the recovery
// session type (workout_sessions.is_recovery = true).
//
// Copy rules:
//   - Frame around "move better / feel less stiff" — never "injury prevention",
//     "rehab", "fix your X", or "physio". We aren't qualified to make those
//     claims and they invite the wrong expectations.
//   - Doses are explicitly LIGHT. These are prehab doses, not working sets.
//     Use durations or easy sets×reps (e.g. "2 × 15 controlled" or "60s
//     per side"). Don't write reps schemes that look like a working lift.
//
// Coverage: mobility + loaded mobility for the big joints, plus light prehab
// for the neglected fast-recovering areas — neck, forearms/grip, rotator
// cuff & scapular, calves, light core. ~25-40 items is the right size; the
// recovery generator (next prompt) will pull a small subset per session.

export type RecoveryCategory = 'mobility' | 'prehab' | 'core' | 'cardio';

/** User-facing menu category — what the rest-day picker offers. Maps to
 *  one or more (category, area) filters in the generator. Kept separate
 *  from RecoveryCategory so the catalog stays semantic (movement type)
 *  while the menu can present friendlier groupings ("Forearms & Grip"
 *  bundles two areas; "Calves" includes the tibialis-area item). */
export type RecoveryMenuCategory =
  | 'core'
  | 'forearms_grip'
  | 'calves'
  | 'cardio'
  | 'mobility';

export type RecoveryArea =
  | 'neck'
  | 'rotator_cuff'
  | 'scapular'
  | 'thoracic'
  | 'forearms'
  | 'grip'
  | 'hips'
  | 'hamstrings'
  | 'glutes'
  | 'ankles'
  | 'calves'
  | 'core'
  | 'lower_back'
  | 'full_body';

export type RecoveryLocation = 'home' | 'gym' | 'both';

export type RecoveryEquipment =
  | 'none'
  | 'band'
  | 'light_dumbbell'
  | 'mat'
  | 'foam_roller'
  | 'bar'
  | 'wall'
  | 'cable'
  | 'ab_wheel'
  | 'plate'
  | 'cardio_machine';

/** Dose for a single recovery item. Either a duration (per side or total)
 *  or a light sets×reps target. Use the field that reads most naturally
 *  for the movement — both are valid; consumers display whichever is set. */
export interface RecoveryDose {
  /** "2 × 15", "3 × 10 per side", etc. Keep numbers low — these are not
   *  working sets. */
  setsReps?: string;
  /** "60s per side", "2 min total". For sustained holds and slow flows. */
  duration?: string;
}

export interface RecoveryExercise {
  /** Stable name used as the exercise_logs.exercise_name when logged. Pick
   *  something specific enough that a search across the user's history
   *  doesn't collide with a training lift. */
  name: string;
  category: RecoveryCategory;
  area: RecoveryArea;
  equipment: RecoveryEquipment;
  location: RecoveryLocation;
  dose: RecoveryDose;
  /** One short coaching cue, framed around movement quality / how it should
   *  feel — never injury-prevention copy. */
  cue: string;
  /** Optional thumbnail. Mirrors the URL pattern used in
   *  src/constants/exercises.ts (free-exercise-db). Leave undefined for
   *  items with no good match — the rest-day card falls back to a
   *  per-category illustration block, not a blank gap. */
  imageUrl?: string;
  /** Selection quality, 1 (weak / low-yield) to 3 (staple). The rest-day
   *  generator sorts the seeded-shuffled pool by this descending, so
   *  staples (plank, hanging knee raise) get picked over filler (dead bug,
   *  bird dog) while day-to-day variety is preserved among equal tiers.
   *  Undefined defaults to 2. */
  quality?: 1 | 2 | 3;
}

const FED = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises';

// ── Mobility — flows & dynamic stretches ──────────────────────────────

const MOBILITY: RecoveryExercise[] = [
  {
    name: 'Cat-Cow',
    imageUrl: `${FED}/Cat_Stretch/0.jpg`,
    category: 'mobility',
    area: 'thoracic',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 10 slow' },
    cue: 'breathe with the motion — exhale to round, inhale to extend',
  },
  {
    name: 'Thoracic Open Book',
    category: 'mobility',
    area: 'thoracic',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 8 per side' },
    cue: 'let the chest follow the hand, eyes track the thumb',
  },
  {
    name: 'World\'s Greatest Stretch',
    imageUrl: `${FED}/Worlds_Greatest_Stretch/0.jpg`,
    category: 'mobility',
    area: 'hips',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 5 per side' },
    cue: 'hold each rotation for a breath, no bouncing',
  },
  {
    name: '90/90 Hip Switch',
    category: 'mobility',
    area: 'hips',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 10 alternating' },
    cue: 'sit tall through both knees, drive from the glute',
  },
  {
    name: 'Deep Squat Hold',
    imageUrl: `${FED}/Bodyweight_Squat/0.jpg`,
    category: 'mobility',
    area: 'hips',
    equipment: 'none',
    location: 'both',
    dose: { duration: '60-90s total' },
    cue: 'heels down, elbows nudge the knees out',
  },
  {
    name: 'Couch Stretch',
    category: 'mobility',
    area: 'hips',
    equipment: 'mat',
    location: 'both',
    dose: { duration: '45s per side' },
    cue: 'tuck the pelvis under, you\'ll feel the front of the hip light up',
  },
  {
    name: 'Adductor Rock-Back',
    category: 'mobility',
    area: 'hips',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 10 slow' },
    cue: 'rock back with a flat back, breathe into the inner thigh',
  },
  {
    name: 'Wall Slide',
    category: 'mobility',
    area: 'scapular',
    equipment: 'wall',
    location: 'both',
    dose: { setsReps: '2 × 12' },
    cue: 'keep the lower back pressed against the wall the whole way',
  },
  {
    name: 'Thread the Needle',
    category: 'mobility',
    area: 'thoracic',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 6 per side' },
    cue: 'reach long, then unwind even longer the other direction',
  },
  {
    name: 'Standing Hamstring Sweep',
    imageUrl: `${FED}/Standing_Hamstring_and_Calf_Stretch/0.jpg`,
    category: 'mobility',
    area: 'hamstrings',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 10 per side' },
    cue: 'soft knee on the standing leg, sweep low and slow',
  },
  {
    name: 'Ankle Wall Mobility',
    category: 'mobility',
    area: 'ankles',
    equipment: 'wall',
    location: 'both',
    dose: { setsReps: '2 × 10 per side' },
    cue: 'drive the knee past the toe without the heel lifting',
  },
  {
    name: 'Banded Hip Flexor Stretch',
    imageUrl: `${FED}/Intermediate_Hip_Flexor_and_Quad_Stretch/0.jpg`,
    category: 'mobility',
    area: 'hips',
    equipment: 'band',
    location: 'gym',
    dose: { duration: '45s per side' },
    cue: 'gentle band pull — you\'re creating space, not yanking',
  },
];

// ── Prehab — light targeted work for under-served areas ───────────────

const PREHAB: RecoveryExercise[] = [
  {
    name: 'Neck Isometric — Forward',
    imageUrl: `${FED}/Isometric_Neck_Exercise_-_Front_And_Back/0.jpg`,
    category: 'prehab',
    area: 'neck',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 10s holds' },
    cue: 'press the hand into the forehead, easy effort, breathe normally',
  },
  {
    name: 'Neck Isometric — Side',
    imageUrl: `${FED}/Isometric_Neck_Exercise_-_Sides/0.jpg`,
    category: 'prehab',
    area: 'neck',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 10s per side' },
    cue: 'shoulder stays soft and down, push gently',
  },
  {
    name: 'Chin Tuck',
    category: 'prehab',
    area: 'neck',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 12 slow' },
    cue: 'slide the head straight back, not down — double-chin on purpose',
  },
  {
    name: 'Band Pull-Apart',
    imageUrl: `${FED}/Band_Pull_Apart/0.jpg`,
    category: 'prehab',
    area: 'scapular',
    equipment: 'band',
    location: 'both',
    dose: { setsReps: '2 × 15' },
    cue: 'pull from the mid-back, pause briefly at full open',
  },
  {
    name: 'Face Pull (light)',
    category: 'prehab',
    area: 'rotator_cuff',
    equipment: 'band',
    location: 'gym',
    dose: { setsReps: '2 × 15 controlled' },
    cue: 'rope to forehead, thumbs back, no shrug',
    imageUrl: `${FED}/Face_Pull/0.jpg`,
  },
  {
    name: 'External Rotation — Side-lying',
    imageUrl: `${FED}/External_Rotation/0.jpg`,
    category: 'prehab',
    area: 'rotator_cuff',
    equipment: 'light_dumbbell',
    location: 'both',
    dose: { setsReps: '2 × 12 per side' },
    cue: 'elbow glued to the ribs, small range, light weight wins',
  },
  {
    name: 'External Rotation — Banded',
    imageUrl: `${FED}/External_Rotation_with_Band/0.jpg`,
    category: 'prehab',
    area: 'rotator_cuff',
    equipment: 'band',
    location: 'both',
    dose: { setsReps: '2 × 15 per side' },
    cue: 'rotate from the shoulder, not the wrist',
  },
  {
    name: 'Scapular Push-up',
    category: 'prehab',
    area: 'scapular',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 12 slow' },
    cue: 'arms locked, only the shoulder blades move',
  },
  {
    name: 'Scapular Pull-up Hang',
    imageUrl: `${FED}/Scapular_Pull-Up/0.jpg`,
    category: 'prehab',
    area: 'scapular',
    equipment: 'bar',
    location: 'gym',
    dose: { setsReps: '2 × 8' },
    cue: 'pull the shoulders into the back pockets, no bend in the elbows',
  },
  {
    name: 'Dead Hang',
    category: 'prehab',
    area: 'grip',
    equipment: 'bar',
    location: 'gym',
    dose: { duration: '2 × 20-30s' },
    cue: 'shoulders engaged, slow steady breath',
  },
  {
    name: 'Wrist Flexor Stretch',
    imageUrl: `${FED}/Wrist_Circles/0.jpg`,
    category: 'prehab',
    area: 'forearms',
    equipment: 'none',
    location: 'both',
    dose: { duration: '30s per side' },
    cue: 'palm up, gentle pressure — should feel like a long stretch, not a pull',
  },
  {
    name: 'Wrist Extensor Stretch',
    category: 'prehab',
    area: 'forearms',
    equipment: 'none',
    location: 'both',
    dose: { duration: '30s per side' },
    cue: 'palm down, fingers point at you, breathe through it',
  },
  {
    name: 'Towel Wring',
    category: 'prehab',
    area: 'forearms',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 10 each direction' },
    cue: 'slow controlled twist, both directions matter',
  },
  {
    name: 'Standing Calf Raise (light)',
    category: 'prehab',
    area: 'calves',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 15 slow' },
    cue: 'all the way up, all the way down — pause at the top',
    imageUrl: `${FED}/Standing_Calf_Raises/0.jpg`,
  },
  {
    name: 'Seated Soleus Raise',
    category: 'prehab',
    area: 'calves',
    equipment: 'light_dumbbell',
    location: 'both',
    dose: { setsReps: '2 × 15' },
    cue: 'bent knee targets the deeper calf — go slow',
    imageUrl: `${FED}/Seated_Calf_Raise/0.jpg`,
  },
  {
    name: 'Tibialis Raise',
    category: 'prehab',
    area: 'ankles',
    equipment: 'wall',
    location: 'both',
    dose: { setsReps: '2 × 15' },
    cue: 'heels stay planted, lift the toes hard',
  },
  {
    name: 'Glute Bridge (light)',
    category: 'prehab',
    area: 'glutes',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 12' },
    cue: 'squeeze at the top, ribs stay down',
    imageUrl: `${FED}/Single_Leg_Glute_Bridge/0.jpg`,
  },
  {
    name: 'Clamshell',
    category: 'prehab',
    area: 'glutes',
    equipment: 'band',
    location: 'both',
    dose: { setsReps: '2 × 12 per side' },
    cue: 'top knee opens like a book, hips stay stacked',
  },
  {
    name: 'Single-leg Calf Walk',
    category: 'prehab',
    area: 'calves',
    equipment: 'none',
    location: 'both',
    dose: { setsReps: '2 × 15 steps per side' },
    cue: 'roll through the toes, deliberate tempo',
    imageUrl: `${FED}/Standing_Calf_Raises/0.jpg`,
  },
  // ── Loaded grip / forearm work — light accessory dose ────────────────
  // These complement the stretches above. The forearms_grip menu in the
  // generator pulls from this whole area pool. Copy framed as "light
  // accessory" — never load-PR territory.
  {
    name: 'Wrist Curl (light)',
    imageUrl: `${FED}/Palms-Up_Barbell_Wrist_Curl_Over_A_Bench/0.jpg`,
    category: 'prehab',
    area: 'forearms',
    equipment: 'light_dumbbell',
    location: 'both',
    dose: { setsReps: '2 × 15 controlled' },
    cue: 'palm up, small range — burn the forearm, not the wrist',
  },
  {
    name: 'Reverse Wrist Curl (light)',
    imageUrl: `${FED}/Palms-Down_Wrist_Curl_Over_A_Bench/0.jpg`,
    category: 'prehab',
    area: 'forearms',
    equipment: 'light_dumbbell',
    location: 'both',
    dose: { setsReps: '2 × 15 controlled' },
    cue: 'palm down, slow descent — top of the forearm does the work',
  },
  {
    name: 'Farmer Hold',
    imageUrl: `${FED}/Farmers_Walk/0.jpg`,
    category: 'prehab',
    area: 'grip',
    equipment: 'light_dumbbell',
    location: 'both',
    dose: { duration: '2 × 30-45s' },
    cue: 'tall posture, ribs down — just hold and breathe',
  },
  {
    name: 'Plate Pinch',
    imageUrl: `${FED}/Plate_Pinch/0.jpg`,
    category: 'prehab',
    area: 'grip',
    equipment: 'plate',
    location: 'gym',
    dose: { duration: '2 × 20-30s per side' },
    cue: 'pinch hard with the thumb, stay relaxed everywhere else',
  },
];

// ── Core — light, non-fatiguing ───────────────────────────────────────

const CORE: RecoveryExercise[] = [
  {
    name: 'Dead Bug',
    quality: 1,
    imageUrl: `${FED}/Dead_Bug/0.jpg`,
    category: 'core',
    area: 'core',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 8 per side' },
    cue: 'lower back stays glued to the floor — that\'s the whole game',
  },
  {
    name: 'Bird Dog',
    quality: 1,
    category: 'core',
    area: 'core',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 8 per side' },
    cue: 'reach long, pause one second, return controlled',
  },
  {
    name: 'Side Plank Hold',
    quality: 3,
    imageUrl: `${FED}/Side_Bridge/0.jpg`,
    category: 'core',
    area: 'core',
    equipment: 'mat',
    location: 'both',
    dose: { duration: '20-30s per side' },
    cue: 'stack the shoulders, hips drive up — don\'t sag',
  },
  {
    name: 'Front Plank',
    quality: 3,
    category: 'core',
    area: 'core',
    equipment: 'mat',
    location: 'both',
    dose: { duration: '20-30s' },
    cue: 'ribs down, glutes on, breathe',
    imageUrl: `${FED}/Plank/0.jpg`,
  },
  {
    name: 'McGill Curl-up',
    quality: 1,
    category: 'core',
    area: 'core',
    equipment: 'mat',
    location: 'both',
    dose: { setsReps: '2 × 6' },
    cue: 'tiny range — chin tucked, hands under the lower back',
  },
  {
    name: 'Pallof Press',
    quality: 3,
    imageUrl: `${FED}/Pallof_Press/0.jpg`,
    category: 'core',
    area: 'core',
    equipment: 'band',
    location: 'both',
    dose: { setsReps: '2 × 10 per side' },
    cue: 'resist the rotation — don\'t make it, prevent it',
  },
  // ── Top-ups so the Core menu is well-populated ──────────────────────
  {
    name: 'Hanging Knee Raise',
    quality: 3,
    category: 'core',
    area: 'core',
    equipment: 'bar',
    location: 'gym',
    dose: { setsReps: '2 × 10 controlled' },
    cue: 'slow up, slow down — no kipping, no swing',
    imageUrl: `${FED}/Hanging_Leg_Raise/0.jpg`,
  },
  {
    name: 'Cable Crunch',
    quality: 3,
    category: 'core',
    area: 'core',
    equipment: 'cable',
    location: 'gym',
    dose: { setsReps: '2 × 12 light' },
    cue: 'curl the ribs toward the hips — pull from the abs, not the arms',
    imageUrl: `${FED}/Cable_Crunch/0.jpg`,
  },
  {
    name: 'Ab Wheel Rollout',
    quality: 3,
    category: 'core',
    area: 'core',
    equipment: 'ab_wheel',
    location: 'both',
    dose: { setsReps: '2 × 6-8 short range' },
    cue: 'short range only — back stays flat, no sagging',
    imageUrl: `${FED}/Ab_Roller/0.jpg`,
  },
];

// ── Cardio — low-intensity, conversational pace ──────────────────────
// Zone-2 steady-state work. Doses are durations only — these are NEVER
// intervals or "push the pace" sessions. The menu's user-facing copy
// reinforces the conversational-pace intent. Copy framing: this is
// circulation, not conditioning; light accessory work that won't
// interfere with tomorrow's main lifts.

const CARDIO: RecoveryExercise[] = [
  {
    name: 'Incline Treadmill Walk',
    imageUrl: `${FED}/Walking_Treadmill/0.jpg`,
    category: 'cardio',
    area: 'full_body',
    equipment: 'cardio_machine',
    location: 'gym',
    dose: { duration: '15-20 min' },
    cue: 'easy incline, conversational pace — you should be able to talk',
  },
  {
    name: 'Easy Stationary Bike',
    imageUrl: `${FED}/Recumbent_Bike/0.jpg`,
    category: 'cardio',
    area: 'full_body',
    equipment: 'cardio_machine',
    location: 'both',
    dose: { duration: '15-20 min' },
    cue: 'low resistance, steady cadence — circulation, not a workout',
  },
  {
    name: 'Rower Easy Pace',
    category: 'cardio',
    area: 'full_body',
    equipment: 'cardio_machine',
    location: 'both',
    dose: { duration: '10-15 min' },
    cue: 'long strokes, easy pace — nose-breathing if you can',
  },
  {
    name: 'Stair Climber Steady',
    imageUrl: `${FED}/Stairmaster/0.jpg`,
    category: 'cardio',
    area: 'full_body',
    equipment: 'cardio_machine',
    location: 'gym',
    dose: { duration: '12-15 min' },
    cue: 'steady step rate, light grip on the rails — no hanging on',
  },
  {
    name: 'Brisk Outdoor Walk',
    imageUrl: `${FED}/Walking_Treadmill/0.jpg`,
    category: 'cardio',
    area: 'full_body',
    equipment: 'none',
    location: 'both',
    dose: { duration: '15-20 min' },
    cue: 'easy effort — moving for the sake of moving',
  },
];

/** The full recovery catalog. Stable export order so consumers iterating
 *  this list get a deterministic stream — the upcoming generator may seed
 *  selection from it. */
export const RECOVERY_EXERCISES: readonly RecoveryExercise[] = [
  ...MOBILITY,
  ...PREHAB,
  ...CORE,
  ...CARDIO,
];

/** Convenience: find a recovery item by exact name. Used by display layers
 *  that need cue / dose / category for a logged recovery row. */
export function findRecoveryExercise(name: string): RecoveryExercise | undefined {
  return RECOVERY_EXERCISES.find(r => r.name === name);
}

/** Set of all recovery exercise names — useful for audit / exclusion checks
 *  that test whether a logged row was a recovery item rather than a lift. */
export const RECOVERY_EXERCISE_NAMES: ReadonlySet<string> = new Set(
  RECOVERY_EXERCISES.map(e => e.name),
);