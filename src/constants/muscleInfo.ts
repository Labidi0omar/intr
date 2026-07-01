// Muscle info content — name, description, and body-position metadata
// for the exercise details card. The description is written in the app's
// voice: direct, honest, no fluff. It tells the user WHAT the muscle is,
// WHY it matters, and what it looks like when developed.
//
// `view` controls which side of the figure to render (front or back).
// `slug` is the body-part identifier used by react-native-body-highlighter
// — each (view, slug) pair matches an anatomically correct path in the
// library's front/back assets (e.g. shoulders → deltoids on front,
// rear delts → deltoids on back, back → upper-back on back).

import type { Slug } from 'react-native-body-highlighter';

export interface MuscleInfo {
  /** Display name — capitalized. */
  name: string;
  /** One-paragraph description in the app voice. ≤ 200 chars. */
  description: string;
  /** Which body view to render. */
  view: 'front' | 'back';
  /** Library muscle slug. Null when we have no valid mapping — the
   *  details card will render no figure rather than mis-highlight. */
  slug: Slug | null;
  /** Short label for the body position (e.g. "Upper back", "Front arm"). */
  region: string;
}

const MUSCLE_INFO: Record<string, MuscleInfo> = {
  chest: {
    name: 'Chest',
    description: 'The pecs. Fills out a t-shirt and powers every push. Upper chest gives the shelf; lower chest gives the sweep. This is the muscle everyone checks first.',
    view: 'front',
    slug: 'chest',
    region: 'Upper torso — front',
  },
  back: {
    name: 'Back',
    description: 'Lats, traps, and rhomboids. The muscle that gives you wings — a wide back is what makes a V-taper visible from the front. This is what makes you look like you lift, even in a hoodie.',
    view: 'back',
    slug: 'upper-back',
    region: 'Upper back',
  },
  biceps: {
    name: 'Biceps',
    description: 'The front of the arm. Short head for thickness, long head for the peak. The muscle people check in the mirror — but it\'s also the engine of every pull.',
    view: 'front',
    slug: 'biceps',
    region: 'Front arm',
  },
  triceps: {
    name: 'Triceps',
    description: 'The back of the arm. Two-thirds of your arm size is triceps, not biceps. This is what fills out a sleeve and what locks out every press.',
    view: 'back',
    slug: 'triceps',
    region: 'Back arm',
  },
  shoulders: {
    name: 'Shoulders',
    description: 'The delts. The rounded cap on your shoulder. Side delts give you width; front delts push; rear delts pull and keep posture honest. Wide shoulders make the V-taper.',
    view: 'front',
    slug: 'deltoids',
    region: 'Shoulders',
  },
  'rear delts': {
    name: 'Rear Delts',
    description: 'The back of the shoulder. Small but critical — they balance the front delts, keep shoulders from rolling forward, and add the 3D look from behind. The most undertrained muscle in the gym.',
    view: 'back',
    slug: 'deltoids',
    region: 'Back of shoulder',
  },
  quads: {
    name: 'Quads',
    description: 'The front of the thigh. Fills out pants and powers every squat and lunge. The teardrop (VMO) is what shows below shorts. The biggest visible leg muscle.',
    view: 'front',
    slug: 'quadriceps',
    region: 'Front thigh',
  },
  hamstrings: {
    name: 'Hamstrings',
    description: 'The back of the thigh. Balances the quads and powers every deadlift. Undertrained by most — weak hamstrings are why squats stall and why knees complain.',
    view: 'back',
    slug: 'hamstring',
    region: 'Back thigh',
  },
  glutes: {
    name: 'Glutes',
    description: 'The butt. The strongest muscle group in the body. Powers the hip thrust, stabilizes every squat, and gives shape. The engine of the lower body — don\'t skip it.',
    view: 'back',
    slug: 'gluteal',
    region: 'Hips — back',
  },
  calves: {
    name: 'Calves',
    description: 'The lower leg. The most stubborn muscle — they recover fast, grow slow, and show in shorts. Train them heavy, train them often. Most people skip them and regret it.',
    view: 'back',
    slug: 'calves',
    region: 'Lower leg — back',
  },
  abs: {
    name: 'Abs',
    description: 'The core. Stabilizes every lift, protects your back, and shows through at low body fat. Train them like any other muscle — weighted, progressive, not just endless crunches.',
    view: 'front',
    slug: 'abs',
    region: 'Midsection — front',
  },
};

/** Get muscle info for an exercise's primaryMuscle field. Returns null
 *  for unknown muscles so the caller can skip the Details button. */
export function getMuscleInfo(primaryMuscle: string | null | undefined): MuscleInfo | null {
  if (!primaryMuscle) return null;
  return MUSCLE_INFO[primaryMuscle.toLowerCase().trim()] ?? null;
}
