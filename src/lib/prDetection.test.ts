// Tests for computeSessionPrs — the pure PR comparison the workout finish
// flow (app/workout.tsx Phase 5) and the completion PR card feed from.
//
// The headline regression is the real intr@gmail.com session of
// 2026-06-11: Barbell Squat 90→95, Leg Press 140→150, Leg Extension 50
// (first time in the 56-day window) — three genuine PRs, zero surfaced.
// Root cause: the durable save runs BEFORE the prior-log fetch, and the
// fetch had no upper date bound, so each lift's own just-saved row came
// back as its "prior best" and every comparison failed against itself.

import { computeSessionPrs } from './prDetection';

const SESSION_DATE = '2026-06-11';

// The committed logRows for the session — the same rows the durable save
// persisted to exercise_logs.
const SESSION_ROWS = [
  { exercise_name: 'Barbell Squat', weight_kg: 95 },
  { exercise_name: 'Leg Press', weight_kg: 150 },
  { exercise_name: 'Leg Extension', weight_kg: 50 },
];

// Genuine priors inside the 56-day window (what the fixed, date-bounded
// fetch returns): squat and leg press history, nothing for leg extension.
const GENUINE_PRIORS = [
  { exercise_name: 'Barbell Squat', weight_kg: 90, logged_date: '2026-06-08' },
  { exercise_name: 'Barbell Squat', weight_kg: 85, logged_date: '2026-05-25' },
  { exercise_name: 'Leg Press', weight_kg: 140, logged_date: '2026-06-08' },
  { exercise_name: 'Leg Press', weight_kg: 135, logged_date: '2026-05-25' },
];

describe('REPRO intr@gmail.com 2026-06-11 — all three PRs surface', () => {
  it('Squat 90→95, Leg Press 140→150, Leg Extension first-in-56d all land in prs', () => {
    const { prs } = computeSessionPrs(SESSION_ROWS, GENUINE_PRIORS, SESSION_DATE);
    expect(prs).toEqual(['Barbell Squat', 'Leg Press', 'Leg Extension']);
  });

  it('the completion card gets the committed weights for every PR', () => {
    // prWeights is the card's display source — must carry the exact
    // committed numbers, keyed by the logged exercise names.
    const { prWeights } = computeSessionPrs(SESSION_ROWS, GENUINE_PRIORS, SESSION_DATE);
    expect(prWeights['Barbell Squat']).toBe(95);
    expect(prWeights['Leg Press']).toBe(150);
    expect(prWeights['Leg Extension']).toBe(50);
  });

  it('coach-message meta covers only lifts with a prior best (first-time lift = badge only)', () => {
    const { meta } = computeSessionPrs(SESSION_ROWS, GENUINE_PRIORS, SESSION_DATE);
    expect(meta).toEqual([
      { name: 'Barbell Squat', newWeightKg: 95, prevBestKg: 90 },
      { name: 'Leg Press', newWeightKg: 150, prevBestKg: 140 },
    ]);
  });

  it('BUG SHAPE: priors polluted with the session\'s own just-saved rows still yield all three', () => {
    // What the unbounded fetch actually returned in production: the rows
    // the durable save inserted moments earlier, dated today. The date
    // guard must drop them so the comparison runs against real history.
    const pollutedPriors = [
      ...GENUINE_PRIORS,
      { exercise_name: 'Barbell Squat', weight_kg: 95, logged_date: SESSION_DATE },
      { exercise_name: 'Leg Press', weight_kg: 150, logged_date: SESSION_DATE },
      { exercise_name: 'Leg Extension', weight_kg: 50, logged_date: SESSION_DATE },
    ];
    const { prs, meta } = computeSessionPrs(SESSION_ROWS, pollutedPriors, SESSION_DATE);
    expect(prs).toEqual(['Barbell Squat', 'Leg Press', 'Leg Extension']);
    expect(meta).toEqual([
      { name: 'Barbell Squat', newWeightKg: 95, prevBestKg: 90 },
      { name: 'Leg Press', newWeightKg: 150, prevBestKg: 140 },
    ]);
  });
});

describe('computeSessionPrs — semantics', () => {
  it('no PR when the new weight ties or trails the window best', () => {
    const { prs, meta } = computeSessionPrs(
      [
        { exercise_name: 'Barbell Squat', weight_kg: 90 }, // tie
        { exercise_name: 'Leg Press', weight_kg: 130 },    // below
      ],
      GENUINE_PRIORS,
      SESSION_DATE,
    );
    expect(prs).toEqual([]);
    expect(meta).toEqual([]);
  });

  it('bodyweight rows (weight_kg null) never enter PR detection', () => {
    const { prs, prWeights } = computeSessionPrs(
      [{ exercise_name: 'Pull-Up', weight_kg: null }],
      [],
      SESSION_DATE,
    );
    expect(prs).toEqual([]);
    expect(prWeights).toEqual({});
  });

  it('SWAP: a swapped exercise is keyed by its NEW name — old-name history neither suppresses nor leaks', () => {
    // The user swapped Leg Press → Hack Squat mid-session; the commit path
    // writes under workout[i].name, so the logged row carries 'Hack Squat'.
    // History under 'Leg Press' must not suppress the new lift, and the
    // new lift (no Hack Squat history in-window) gets the first-time badge.
    const { prs, meta, prWeights } = computeSessionPrs(
      [{ exercise_name: 'Hack Squat', weight_kg: 120 }],
      [{ exercise_name: 'Leg Press', weight_kg: 140, logged_date: '2026-06-08' }],
      SESSION_DATE,
    );
    expect(prs).toEqual(['Hack Squat']);
    expect(meta).toEqual([]); // first-time: badge, no coach message
    expect(prWeights['Hack Squat']).toBe(120);
  });

  it('priors without a logged_date are trusted as genuine history (pre-bounded callers)', () => {
    const { prs, meta } = computeSessionPrs(
      [{ exercise_name: 'Barbell Squat', weight_kg: 95 }],
      [{ exercise_name: 'Barbell Squat', weight_kg: 90 }],
      SESSION_DATE,
    );
    expect(prs).toEqual(['Barbell Squat']);
    expect(meta).toEqual([{ name: 'Barbell Squat', newWeightKg: 95, prevBestKg: 90 }]);
  });

  it('null/NaN prior weights are ignored rather than poisoning Math.max', () => {
    const { prs } = computeSessionPrs(
      [{ exercise_name: 'Barbell Squat', weight_kg: 95 }],
      [
        { exercise_name: 'Barbell Squat', weight_kg: null, logged_date: '2026-06-01' },
        { exercise_name: 'Barbell Squat', weight_kg: 90, logged_date: '2026-06-08' },
      ],
      SESSION_DATE,
    );
    expect(prs).toEqual(['Barbell Squat']);
  });
});
