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

describe('parity: prescribeLoad RN vs Deno', () => {
  it('produces identical output across the full input grid', () => {
    let cells = 0;
    const mismatches: string[] = [];
    for (const lastWeightKg of WEIGHTS) {
      for (const lastRir of RIRS) {
        for (const energyScore of ENERGY) {
          for (const isCompound of COMPOUND) {
            for (const fitnessLevel of LEVELS) {
              cells++;
              const input: PrescriptionInput = {
                lastWeightKg, lastRir, energyScore, isCompound, fitnessLevel,
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
    // Grid sanity: 3 weights × 5 RIRs × 3 energies × 2 compounds × 3 levels = 270.
    expect(cells).toBe(270);
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
