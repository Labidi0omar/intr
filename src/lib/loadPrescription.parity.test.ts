// Parity test between the canonical RN copy (src/lib/loadPrescription.ts +
// src/lib/planGeneration.ts::isCompoundName) and the Deno copy
// (supabase/functions/_shared/loadPrescription.ts).
//
// Why this exists: the Deno edge-function runtime cannot import RN code,
// so the algorithm is intentionally duplicated. This test exercises both
// implementations over a full input grid and fails CI the moment they drift.
//
// If you change one file, you MUST change the other and this suite will
// confirm parity. If they ever genuinely need to differ, delete this test
// and own the divergence explicitly — do not silently disable it.

import {
  prescribeLoad as prescribeLoadRN,
  type PrescriptionInput,
} from './loadPrescription';
import { isCompoundName as isCompoundNameRN } from './planGeneration';
import {
  prescribeLoad as prescribeLoadDeno,
  isCompoundName as isCompoundNameDeno,
} from '../../supabase/functions/_shared/loadPrescription';

// ── Grid for prescribeLoad ─────────────────────────────────────────────
const RIRS: (number | null)[] = [0, 1, 2, 3, null];
const ENERGY: number[] = [1, 3, 5];
const COMPOUND: boolean[] = [true, false];
const LEVELS: (PrescriptionInput['fitnessLevel'])[] = ['beginner', 'intermediate', undefined];
const WEIGHTS: number[] = [0, 20, 100];
// v2 axes — goal-aware ladder + calibration damper + top-of-band gate.
// Sampled sparingly (2-3 values each) to keep the cell count manageable
// while still catching drift on the new branches.
const GOALS: PrescriptionInput['goal'][] = ['strength', 'muscle', 'general', undefined];
const SESSION_COUNTS: (number | undefined)[] = [undefined, 0, 5];
const REP_BANDS: { lastReps: number | undefined; topReps: number | undefined }[] = [
  { lastReps: undefined, topReps: undefined },
  { lastReps: 8,  topReps: 12 },   // gate active, below top
  { lastReps: 12, topReps: 12 },   // gate active, at top
];

describe('parity: prescribeLoad RN vs Deno', () => {
  it('produces identical output across the full input grid', () => {
    let cells = 0;
    const mismatches: string[] = [];
    for (const lastWeightKg of WEIGHTS) {
      for (const lastRir of RIRS) {
        for (const energyScore of ENERGY) {
          for (const isCompound of COMPOUND) {
            for (const fitnessLevel of LEVELS) {
              for (const goal of GOALS) {
                for (const sessionCountForLift of SESSION_COUNTS) {
                  for (const { lastReps, topReps } of REP_BANDS) {
                    cells++;
                    const input: PrescriptionInput = {
                      lastWeightKg, lastRir, energyScore, isCompound, fitnessLevel,
                      goal, sessionCountForLift, lastReps, topReps,
                    };
                    const a = prescribeLoadRN(input);
                    const b = prescribeLoadDeno(input);
                    if (
                      a.suggestedWeightKg !== b.suggestedWeightKg ||
                      a.deltaPct !== b.deltaPct ||
                      a.rationale !== b.rationale
                    ) {
                      mismatches.push(
                        `input=${JSON.stringify(input)} RN=${JSON.stringify(a)} Deno=${JSON.stringify(b)}`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // Grid sanity: 3 weights × 5 RIRs × 3 energies × 2 compounds × 3 levels
    // × 4 goals × 3 session counts × 3 rep bands = 9720.
    expect(cells).toBe(9720);
    if (mismatches.length > 0) {
      // Fail loudly with the first few divergences so the cause is obvious.
      throw new Error(
        `prescribeLoad parity broken in ${mismatches.length} cell(s):\n` +
        mismatches.slice(0, 5).join('\n'),
      );
    }
  });
});

// ── isCompoundName parity ──────────────────────────────────────────────
// The Deno copy inlines its own classifier + keyword tables. This list
// covers the three tiers (heavy compound, lighter compound, isolation,
// mid-tier default) so any drift in keywords or thresholds is caught.
const NAMES = [
  'Barbell Bench Press',
  'Back Squat',
  'Conventional Deadlift',
  'Overhead Press',
  'Pull-up',
  'Dumbbell Row',
  'Leg Press',
  'Push-up',
  'Bicep Curl',
  'Lateral Raise',
  'Leg Extension',
  'Cable Fly',
  'Tricep Pushdown',
  'Hammer Curl', // no keyword match → default tier
  'Calf Raise',
  'Face Pull',   // no keyword → default
];

describe('parity: isCompoundName RN vs Deno', () => {
  it.each(NAMES)('matches for %s', (name) => {
    expect(isCompoundNameDeno(name)).toBe(isCompoundNameRN(name));
  });
});
