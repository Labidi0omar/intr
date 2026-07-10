import { buildPrescriptionHero } from './prescriptionPresenter';

describe('buildPrescriptionHero', () => {
  it('failure backoff → "maxed out" reason and backoff tone', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 76, deltaPct: -0.05, rationale: 'backoff', cause: 'failure' },
      lastWeightKg: 80,
      hasLastRir: true,
    });
    expect(h.tone).toBe('backoff');
    expect(h.weightLabel).toBe('76 kg');
    expect(h.deltaLabel).toBe('−4 kg vs last');
    expect(h.reason).toMatch(/maxed out/i);
    // The kg is now woven into the sentence so the directive matches
    // the headline kg.
    expect(h.reason).toContain('76 kg');
  });

  it('low-energy is tone-aware: hold and backoff produce DIFFERENT lines', () => {
    const heldFromLowEnergy = buildPrescriptionHero({
      rx: { suggestedWeightKg: 80, deltaPct: 0, rationale: 'hold', cause: 'low_energy' },
      lastWeightKg: 80,
      hasLastRir: true,
    });
    expect(heldFromLowEnergy.tone).toBe('hold');
    expect(heldFromLowEnergy.deltaLabel).toBe('Same as last');
    // Hold copy talks about staying at the current weight, no grinding.
    expect(heldFromLowEnergy.reason).toMatch(/hold 80 kg.*don't grind/i);

    const backedOffFromLowEnergy = buildPrescriptionHero({
      rx: { suggestedWeightKg: 76, deltaPct: -0.05, rationale: 'backoff', cause: 'low_energy' },
      lastWeightKg: 80,
      hasLastRir: true,
    });
    expect(backedOffFromLowEnergy.tone).toBe('backoff');
    // Backoff copy says the weight is coming down.
    expect(backedOffFromLowEnergy.reason).toMatch(/ease down to 76 kg/i);

    // Same trigger (low energy), different words — the sentence must
    // match what actually happened to the number.
    expect(heldFromLowEnergy.reason).not.toBe(backedOffFromLowEnergy.reason);

    // Both share the same opening clause naming the cause, so the user
    // sees the "why" stays consistent across the split.
    expect(heldFromLowEnergy.reason).toMatch(/energy/i);
    expect(backedOffFromLowEnergy.reason).toMatch(/energy/i);
  });

  it('progression with positive delta → "up to {kg}" causal phrasing', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 84, deltaPct: 0.05, rationale: 'progress', cause: 'rir' },
      lastWeightKg: 80,
      hasLastRir: true,
    });
    expect(h.tone).toBe('progress');
    expect(h.reason).toMatch(/more in you last time/i);
    expect(h.reason).toMatch(/up to 84 kg/i);
    expect(h.deltaLabel).toBe('+4 kg vs last');
  });

  it('rir hold with signal → "felt right last time — match {kg}"', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 80, deltaPct: 0, rationale: 'hold', cause: 'rir' },
      lastWeightKg: 80,
      hasLastRir: true,
    });
    expect(h.reason).toMatch(/felt right last time/i);
    expect(h.reason).toMatch(/match 80 kg/i);
    expect(h.reason).toMatch(/keep the reps clean/i);
    expect(h.tone).toBe('hold');
  });

  it('rir hold without signal → "no read on last time — repeat {kg}"', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 80, deltaPct: 0, rationale: 'hold', cause: 'rir' },
      lastWeightKg: 80,
      hasLastRir: false,
    });
    expect(h.reason).toMatch(/no read on last time/i);
    expect(h.reason).toMatch(/repeat 80 kg/i);
  });

  it('high-energy hold gets the "Energy\'s good — chase an extra rep" framing', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 80, deltaPct: 0, rationale: 'hold', cause: 'rir' },
      lastWeightKg: 80,
      hasLastRir: true,
      energyScore: 5,
    });
    // High energy on a hold day → push reps, not load.
    expect(h.reason).toMatch(/energy's good/i);
    expect(h.reason).toMatch(/match 80 kg/i);
    expect(h.reason).toMatch(/chase an extra rep/i);
    // It must NOT regress to the no-energy hold copy when energy is high.
    expect(h.reason).not.toMatch(/felt right last time/i);
  });

  it('no_history → cold tone, empty labels, calibration copy', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 0, deltaPct: 0, rationale: 'no_history', cause: 'unknown' },
    });
    expect(h.tone).toBe('cold');
    expect(h.weightLabel).toBe('');
    expect(h.deltaLabel).toBe('');
    expect(h.reason).toMatch(/first time on this/i);
  });

  it('undefined rx → cold start', () => {
    const h = buildPrescriptionHero({ rx: undefined });
    expect(h.tone).toBe('cold');
    expect(h.weightLabel).toBe('');
  });

  it('half-plate progression renders with .5 precision in both fields', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 22.5, deltaPct: 0.125, rationale: 'progress', cause: 'rir' },
      lastWeightKg: 20,
      hasLastRir: true,
    });
    expect(h.weightLabel).toBe('22.5 kg');
    expect(h.deltaLabel).toBe('+2.5 kg vs last');
    // Weave-in matches the headline kg.
    expect(h.reason).toContain('22.5 kg');
  });

  it('falls back to suggestedWeightKg when lastWeightKg is missing/zero', () => {
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 60, deltaPct: 0, rationale: 'hold', cause: 'rir' },
      hasLastRir: true,
    });
    // No drift even though caller didn't supply lastWeightKg.
    expect(h.deltaLabel).toBe('Same as last');
  });

  // ── Delta ↔ reason agreement (the original contradiction bug) ────────
  // The old reason was picked off rx.rationale alone. When the engine
  // wanted a progression but the bumped weight rounded to the same plate
  // (small lifts on a 2.5 kg increment, late-cycle plateau), the hero
  // displayed "Same as last" right next to "going up today." The new
  // picker keys off the ROUNDED delta, so the two strings can't disagree.

  it('plate-capped progression (diff rounds to 0) → "match {kg} and earn an extra rep", never "up"', () => {
    // Engine wanted progress, but the suggested weight rounded to the
    // same kg as last (sub-display-resolution bump or plate cap).
    const h = buildPrescriptionHero({
      rx: { suggestedWeightKg: 20, deltaPct: 0.05, rationale: 'progress', cause: 'rir' },
      lastWeightKg: 20,
      hasLastRir: true,
    });
    expect(h.deltaLabel).toBe('Same as last');
    expect(h.reason).toMatch(/more in you last time|more last time/i);
    expect(h.reason).toMatch(/match 20 kg/i);
    expect(h.reason).toMatch(/earn an extra rep/i);
    // The contradiction we're protecting against:
    expect(h.reason).not.toMatch(/\bup to\b/i);
    expect(h.reason).not.toMatch(/going up/i);
  });

  it('delta label and reason never disagree on direction across the matrix', () => {
    // Sweep a representative weight grid. For every produced hero, if
    // the delta label says "Same as last" the reason must not say "up";
    // if the delta is positive the reason must not say "down" or
    // "ease down"; if the delta is negative the reason must not say "up".
    const grid: { suggested: number; last: number; rationale: any; cause: any }[] = [
      // Plate-capped progression — the original bug.
      { suggested: 20, last: 20, rationale: 'progress', cause: 'rir' },
      // Real progression.
      { suggested: 85, last: 80, rationale: 'progress', cause: 'rir' },
      // Hold.
      { suggested: 80, last: 80, rationale: 'hold', cause: 'rir' },
      // Failure backoff.
      { suggested: 76, last: 80, rationale: 'backoff', cause: 'failure' },
      // Low-energy backoff.
      { suggested: 76, last: 80, rationale: 'backoff', cause: 'low_energy' },
      // Low-energy hold (engine didn't downgrade weight).
      { suggested: 80, last: 80, rationale: 'hold', cause: 'low_energy' },
    ];

    for (const row of grid) {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: row.suggested, deltaPct: 0, rationale: row.rationale, cause: row.cause },
        lastWeightKg: row.last,
        hasLastRir: true,
      });
      if (h.deltaLabel === 'Same as last') {
        expect(h.reason).not.toMatch(/\bup to\b/i);
        expect(h.reason).not.toMatch(/going up/i);
        expect(h.reason).not.toMatch(/ease down/i);
      } else if (h.deltaLabel.startsWith('+')) {
        expect(h.reason).not.toMatch(/ease down/i);
        expect(h.reason).not.toMatch(/back off/i);
      } else if (h.deltaLabel.startsWith('−')) {
        expect(h.reason).not.toMatch(/\bup to\b/i);
        expect(h.reason).not.toMatch(/going up/i);
      }
    }
  });

  // ── Plain-language guardrail ─────────────────────────────────────────
  // The presenter shares coachVoice's plain-language standard: no insider
  // terms. The reason now weaves the kg into the sentence directly, and
  // the energy band modulates the wrapper — so the sweep covers
  // energyScore variants too. If a future copy edit slips "reps in
  // reserve" or "RIR" back in on any branch, this catches it.
  it('reason copy is jargon-free across every (rationale, cause, hasLastRir, energyScore) combo', () => {
    const rationales = ['progress', 'backoff', 'hold', 'no_history'] as const;
    // Includes 'time_to_progress' — the cause emitted by applyStallNudge.
    // The new branch's copy ("you've held {kg} for {n} weeks — time to
    // add a little. Earn it.") must clear the same jargon bar as every
    // other reason line.
    const causes = ['rir', 'failure', 'low_energy', 'time_to_progress', 'unknown'] as const;
    const rirSignals = [true, false] as const;
    const energies: (number | undefined)[] = [undefined, 1, 2, 3, 4, 5];
    const banned = [
      'reps in reserve',
      'adding load',
      'in reserve',
      'rir',
      'deload',
      'mesocycle',
      'block week',
    ];

    for (const rationale of rationales) {
      for (const cause of causes) {
        for (const hasLastRir of rirSignals) {
          for (const energyScore of energies) {
            const h = buildPrescriptionHero({
              // stallWeeks set on every combo so the time_to_progress
              // branch fires when it would otherwise short-circuit on
              // missing data. Other branches ignore the field.
              rx: { suggestedWeightKg: 80, deltaPct: 0, rationale, cause, stallWeeks: 3 },
              lastWeightKg: 80,
              hasLastRir,
              energyScore,
            });
            expect(h.reason.length).toBeGreaterThan(0);
            const reasonLc = h.reason.toLowerCase();
            for (const term of banned) {
              if (term === 'rir') {
                expect(h.reason).not.toMatch(/\brir\b/i);
              } else {
                expect(reasonLc).not.toContain(term);
              }
            }
          }
        }
      }
    }
  });

  // ── Stall nudge (time_to_progress) ───────────────────────────────────
  // applyStallNudge bumps the suggested weight when a lift has been parked
  // for ≥ STALL_WEEKS. The hero must show a positive delta AND a reason
  // that names the OLD weight + weeks held — no "Same as last" / "add"
  // contradiction, and the kg in the sentence is the kg the user has been
  // holding, not the bumped target.

  it('time_to_progress → bumped delta, reason names OLD kg + weeks held', () => {
    const h = buildPrescriptionHero({
      rx: {
        // applyStallNudge has already moved the weight.
        suggestedWeightKg: 85,
        deltaPct: 0.05,
        rationale: 'progress',
        cause: 'time_to_progress',
        stallWeeks: 3,
      },
      lastWeightKg: 80,
      hasLastRir: true,
      energyScore: 3,
    });
    // Hero shows the bumped weight as the headline + a real positive delta.
    expect(h.weightLabel).toBe('85 kg');
    expect(h.deltaLabel).toBe('+5 kg vs last');
    expect(h.tone).toBe('progress');
    // Reason names the OLD weight (what the user has been holding) and
    // the number of weeks.
    expect(h.reason).toMatch(/held 80 kg/i);
    expect(h.reason).toMatch(/3 weeks/i);
    expect(h.reason).toMatch(/time to add a little/i);
    expect(h.reason).toMatch(/earn it/i);
  });

  it('time_to_progress falls back to standard progress copy when stallWeeks missing', () => {
    // Defensive: if a legacy caller / serialization path drops stallWeeks,
    // the reason should not say "for undefined weeks." Falls through to
    // the regular "more in you last time" copy.
    const h = buildPrescriptionHero({
      rx: {
        suggestedWeightKg: 85,
        deltaPct: 0.05,
        rationale: 'progress',
        cause: 'time_to_progress',
      },
      lastWeightKg: 80,
      hasLastRir: true,
      energyScore: 3,
    });
    expect(h.reason).not.toMatch(/undefined/i);
    expect(h.reason).toMatch(/up to 85 kg/i);
  });

  // ── Single coherent block (no second sentence wall) ──────────────────
  // The active card used to stack three coach voices: this reason, a
  // separate "Coach:" line, and a micro-line. The merge collapses them
  // into ONE sentence. Future drift toward multi-sentence dumping is
  // caught here.
  it('reason is a single sentence, not a multi-sentence wall', () => {
    const rationales = ['progress', 'backoff', 'hold', 'no_history'] as const;
    const causes = ['rir', 'failure', 'low_energy'] as const;
    const energies = [1, 3, 5];
    for (const rationale of rationales) {
      for (const cause of causes) {
        for (const energyScore of energies) {
          const h = buildPrescriptionHero({
            rx: { suggestedWeightKg: 80, deltaPct: 0, rationale, cause },
            lastWeightKg: 80,
            hasLastRir: true,
            energyScore,
          });
          // Sentences are separated by ". " — count terminal periods that
          // aren't part of decimals. We allow trailing punctuation but
          // not a second "Sentence." block after it.
          const sentences = h.reason
            .split(/(?<=[.!?])\s+/)
            .filter(s => s.trim().length > 0);
          expect(sentences.length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  // ── anchorSeed attribution ("based on your 100×5") ────────────────────
  // Part E of the anchor-seed feature: when a prescription's entire
  // history is a single onboarding-seeded anchor entry, the reason names
  // it — so the first number the user sees visibly ties back to what they
  // typed at onboarding. app/workout.tsx is responsible for only passing
  // anchorSeed while that seed is still the lift's sole history (see the
  // exerciseHistory-length check next to the hero render); the presenter
  // itself just appends the note whenever it's given one.

  describe('anchorSeed attribution', () => {
    it('appends "Based on your {kg}×{reps}." to the reason when anchorSeed is set', () => {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: 85, deltaPct: 0.025, rationale: 'progress', cause: 'rir' },
        lastWeightKg: 82.5,
        hasLastRir: true,
        anchorSeed: { weightKg: 100, reps: 5 },
      });
      expect(h.reason).toMatch(/up to 85 kg/i);
      expect(h.reason).toContain('Based on your 100×5.');
    });

    it('formats the anchor weight the same way as the headline kg (no trailing .0)', () => {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: 85, deltaPct: 0.025, rationale: 'hold', cause: 'rir' },
        lastWeightKg: 82.5,
        hasLastRir: true,
        anchorSeed: { weightKg: 102.5, reps: 5 },
      });
      expect(h.reason).toContain('Based on your 102.5×5.');
    });

    it('does NOT append anything when anchorSeed is absent (the default, common case)', () => {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: 85, deltaPct: 0.025, rationale: 'progress', cause: 'rir' },
        lastWeightKg: 82.5,
        hasLastRir: true,
      });
      expect(h.reason).not.toMatch(/based on/i);
    });

    it('does NOT append when anchorSeed is explicitly null (workout.tsx passes null once a real session is logged)', () => {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: 85, deltaPct: 0.025, rationale: 'progress', cause: 'rir' },
        lastWeightKg: 82.5,
        hasLastRir: true,
        anchorSeed: null,
      });
      expect(h.reason).not.toMatch(/based on/i);
    });

    it('the attribution is exactly one short trailing sentence, not a wall of text', () => {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: 85, deltaPct: 0.025, rationale: 'progress', cause: 'rir' },
        lastWeightKg: 82.5,
        hasLastRir: true,
        anchorSeed: { weightKg: 100, reps: 5 },
      });
      const sentences = h.reason.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
      // The causal reason + exactly one attribution sentence — two total,
      // never more, and the attribution is always the LAST one.
      expect(sentences.length).toBe(2);
      expect(sentences[1]).toBe('Based on your 100×5.');
    });
  });

  // ── derivedEstimate ("≈70kg, estimated from your bench") ──────────────
  // The anchor-derivation feature: a lift with no rx and no lastWeightKg
  // (a true cold start) but a same-session estimate from a DIFFERENT
  // anchor lift (src/lib/anchorDerivation.ts). Must read distinctly
  // softer than anchorSeed's confident "based on your 100×5" — no bold
  // headline weightLabel, the number only appears inside the "≈...kg"
  // reason sentence.

  describe('derivedEstimate', () => {
    it('renders "≈{kg}kg, estimated from your {basis} — calibrate as you go." on the cold-start (undefined rx) path', () => {
      const h = buildPrescriptionHero({
        rx: undefined,
        derivedEstimate: { weightKg: 70, basisLabel: 'bench' },
      });
      expect(h.tone).toBe('cold');
      expect(h.reason).toBe('≈70kg, estimated from your bench — calibrate as you go.');
    });

    it('renders on the no_history rationale path too', () => {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: 0, deltaPct: 0, rationale: 'no_history', cause: 'unknown' },
        derivedEstimate: { weightKg: 45, basisLabel: 'row' },
      });
      expect(h.reason).toBe('≈45kg, estimated from your row — calibrate as you go.');
    });

    it('does NOT show a bold headline weightLabel — the estimate lives only in the reason sentence', () => {
      const h = buildPrescriptionHero({
        rx: undefined,
        derivedEstimate: { weightKg: 70, basisLabel: 'bench' },
      });
      // Deliberately distinct from a real prescription or an anchored
      // lift, both of which populate weightLabel with the bold headline
      // number. A guess must never carry that same visual confidence.
      expect(h.weightLabel).toBe('');
      expect(h.deltaLabel).toBe('');
    });

    it('formats a fractional estimate without a trailing .0, same as every other kg label', () => {
      const h = buildPrescriptionHero({
        rx: undefined,
        derivedEstimate: { weightKg: 77.5, basisLabel: 'bench' },
      });
      expect(h.reason).toContain('≈77.5kg');
    });

    it('falls back to the bare COPY_COLD_START when derivedEstimate is absent (the common case)', () => {
      const h = buildPrescriptionHero({ rx: undefined });
      expect(h.reason).toMatch(/first time on this/i);
      expect(h.reason).not.toMatch(/estimated from/i);
    });

    it('falls back to the bare COPY_COLD_START when derivedEstimate is explicitly null', () => {
      const h = buildPrescriptionHero({ rx: undefined, derivedEstimate: null });
      expect(h.reason).toMatch(/first time on this/i);
    });

    it('falls back to the bare COPY_COLD_START when derivedEstimate has a non-positive weight (defensive)', () => {
      const h = buildPrescriptionHero({ rx: undefined, derivedEstimate: { weightKg: 0, basisLabel: 'bench' } });
      expect(h.reason).toMatch(/first time on this/i);
    });

    it('is textually distinct from the anchorSeed "based on" line — never uses the word "based"', () => {
      const h = buildPrescriptionHero({
        rx: undefined,
        derivedEstimate: { weightKg: 70, basisLabel: 'bench' },
      });
      expect(h.reason).not.toMatch(/based on/i);
      expect(h.reason).toMatch(/estimated from/i);
      expect(h.reason).toMatch(/calibrate as you go/i);
    });

    it('ignores derivedEstimate once a real prescription exists (rx present takes the normal path)', () => {
      const h = buildPrescriptionHero({
        rx: { suggestedWeightKg: 85, deltaPct: 0.025, rationale: 'progress', cause: 'rir' },
        lastWeightKg: 82.5,
        hasLastRir: true,
        derivedEstimate: { weightKg: 70, basisLabel: 'bench' },
      });
      expect(h.reason).not.toMatch(/estimated from/i);
      expect(h.weightLabel).toBe('85 kg');
    });
  });
});

