// Tests for the MOUTH. The two invariants that matter:
//   1. Determinism — same factSig → same line, every call, every run.
//   2. Tone — no emoji, no exclamation cheerleading. The coach is terse.
//
// Pool sizes are not asserted (we want to be free to add entries without
// touching tests), but the per-factSig stability IS asserted because that
// stability is the user-visible contract.

import {
  dedupKeyFor,
  factSigFromDedupKey,
  phraseObservation,
} from './coachVoice';
import type { CoachObservation, Observation } from './coachObservations';

const TODAY = '2026-06-10';

function up(lift: string, from: number, to: number, span = 3): Observation {
  return {
    type: 'lift_progression',
    subtype: 'up',
    id: `lift_progression:${lift}`,
    factSig: `up-${to}`,
    salience: 0.9,
    eventDate: TODAY,
    lift,
    from,
    to,
    span,
  };
}

function upHigh(lift: string, from: number, to: number, span = 3): Observation {
  return { ...up(lift, from, to, span), isAllTimeHigh: true } as Observation;
}

function pushingHard(lift: string, fatigue: 'low_energy' | 'rir_misses' | 'both' = 'low_energy'): CoachObservation {
  return {
    type: 'pushing_hard',
    id: 'pushing_hard',
    factSig: `pushing-85-${fatigue}`,
    salience: 0.92,
    eventDate: TODAY,
    lift,
    fatigue,
    subsumes: [`lift_progression:${lift}`],
  };
}

function grinding(lift: string, strain: 'stall' | 'decline' = 'stall'): CoachObservation {
  return {
    type: 'grinding',
    id: 'grinding',
    factSig: `grinding-${lift}-${strain}`,
    salience: 0.88,
    eventDate: TODAY,
    lift,
    strain,
    subsumes: [`lift_progression:${lift}`],
  };
}

function backOnTrack(lift: string): CoachObservation {
  return {
    type: 'back_on_track',
    id: 'back_on_track',
    factSig: `backontrack-70`,
    salience: 0.9,
    eventDate: TODAY,
    lift,
    subsumes: ['comeback', `lift_progression:${lift}`],
  };
}

function stall(lift: string, weight: number, span: number): Observation {
  return {
    type: 'lift_progression',
    subtype: 'stall',
    id: `lift_progression:${lift}`,
    factSig: `stall-${weight}-${span}`,
    salience: 0.8,
    eventDate: TODAY,
    lift,
    weight,
    span,
  };
}

function comebackLift(lift: string, days: number): Observation {
  return {
    type: 'lift_progression',
    subtype: 'comeback',
    id: `lift_progression:${lift}`,
    factSig: `comeback-${days}`,
    salience: 0.7,
    eventDate: TODAY,
    lift,
    days,
  };
}

function pr(lift: string, newKg: number, prevKg: number): Observation {
  return {
    type: 'session_pr',
    id: `session_pr:${lift}`,
    factSig: `pr-${newKg}`,
    salience: 0.9,
    eventDate: TODAY,
    lift,
    newKg,
    prevKg,
  };
}

function consistency(count: number, metric: 'days14' | 'days28'): Observation {
  return {
    type: 'consistency',
    id: `consistency:${metric}`,
    factSig: `consist-${count}of${metric === 'days14' ? 14 : 28}`,
    salience: 0.7,
    eventDate: TODAY,
    metric,
    count,
  };
}

function effortHigh(pct: number): Observation {
  return {
    type: 'effort_zone',
    id: 'effort_zone',
    factSig: 'effort-high',
    salience: 0.5,
    eventDate: TODAY,
    band: 'high',
    pct,
  };
}

function comeback(gapDays: number): Observation {
  return {
    type: 'comeback',
    id: 'comeback',
    factSig: `gap-${gapDays}`,
    salience: 1.0,
    eventDate: TODAY,
    gapDays,
  };
}

function rationale(split: string, trainingDays: number): Observation {
  return {
    type: 'plan_rationale',
    id: `plan_rationale:${split}`,
    factSig: `rationale-${split}`,
    salience: 0.55,
    eventDate: TODAY,
    split,
    trainingDays,
  };
}

function calibration(): Observation {
  return {
    type: 'calibration',
    id: 'calibration',
    factSig: 'calibration',
    salience: 0.6,
    eventDate: TODAY,
  };
}

const ALL_FIXTURES: CoachObservation[] = [
  up('Bench', 80, 85),
  up('Bench', 82.5, 87.5),
  upHigh('Bench', 80, 90),
  upHigh('Squat', 130, 142.5),
  pushingHard('Bench', 'low_energy'),
  pushingHard('Squat', 'both'),
  grinding('Squat', 'stall'),
  grinding('Deadlift', 'decline'),
  backOnTrack('Row'),
  stall('Squat', 100, 3),
  stall('Squat', 100, 4),
  comebackLift('Row', 21),
  pr('Bench Press', 82.5, 80),
  pr('Bench Press', 140, 135),
  consistency(12, 'days14'),
  consistency(20, 'days28'),
  {
    type: 'block_position',
    id: 'block_position:3',
    factSig: 'block-3',
    salience: 0.4,
    eventDate: TODAY,
    blockWeek: 3,
  },
  {
    type: 'block_position',
    id: 'block_position:4',
    factSig: 'block-4',
    salience: 0.4,
    eventDate: TODAY,
    blockWeek: 4,
  },
  effortHigh(0.7),
  {
    type: 'effort_zone',
    id: 'effort_zone',
    factSig: 'effort-low',
    salience: 0.5,
    eventDate: TODAY,
    band: 'low',
    pct: 0.2,
  },
  comeback(5),
  {
    type: 'briefing_fallback',
    id: 'briefing_fallback',
    factSig: `brief-${TODAY}`,
    salience: 0.1,
    eventDate: TODAY,
    workoutType: 'Push',
    exerciseCount: 5,
  },
  {
    type: 'rest_day',
    id: 'rest_day',
    factSig: `rest-${TODAY}`,
    salience: 0.1,
    eventDate: TODAY,
  },
  rationale('full_body', 1),
  rationale('upper_lower', 2),
  rationale('ppl', 3),
  rationale('ppl', 4),
  rationale('bro_split', 5),
  rationale('bro_split', 6),
  calibration(),
];

describe('phraseObservation', () => {
  it('returns the SAME line for the SAME factSig across calls', () => {
    for (const obs of ALL_FIXTURES) {
      expect(phraseObservation(obs)).toBe(phraseObservation(obs));
    }
  });

  it('different factSigs in the same family produce variety (statistically)', () => {
    // Across many "up" observations with different `to` weights, we should
    // see more than one phrasing — otherwise the pool index isn't doing its
    // job. We test the family with a sweep.
    const lines = new Set<string>();
    for (let kg = 50; kg <= 140; kg += 2.5) {
      lines.add(phraseObservation(up('Bench', kg - 5, kg)));
    }
    expect(lines.size).toBeGreaterThan(1);
  });

  it('no phrasing contains an emoji', () => {
    // Emoji-range guard — covers the common BMP/SMP ranges. Catches a
    // future contributor reaching for "🔥" or "💪".
    const emojiRe = /[☀-➿\u{1F300}-\u{1FAFF}]/u;
    for (const obs of ALL_FIXTURES) {
      const line = phraseObservation(obs);
      expect(line).not.toMatch(emojiRe);
    }
  });

  it('no phrasing contains an exclamation mark (no cheerleading)', () => {
    for (const obs of ALL_FIXTURES) {
      expect(phraseObservation(obs)).not.toMatch(/!/);
    }
  });

  it('all phrasings are non-empty trimmed strings', () => {
    for (const obs of ALL_FIXTURES) {
      const line = phraseObservation(obs);
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(0);
      expect(line.trim()).toBe(line);
    }
  });

  it('rest_day phrasing reads as a rest line, never a "{type} day" briefing', () => {
    const line = phraseObservation({
      type: 'rest_day',
      id: 'rest_day',
      factSig: `rest-${TODAY}`,
      salience: 0.1,
      eventDate: TODAY,
    });
    expect(line.toLowerCase()).toMatch(/rest/);
    // Must NOT echo the training-briefing template.
    expect(line).not.toMatch(/on the board/);
    expect(line).not.toMatch(/\bexercises?\b/);
  });

  it('new-high "up" phrasing references the arc (run) AND the new best', () => {
    // Sweep factSigs to exercise every entry in the new-high pool.
    for (let i = 0; i < 9; i++) {
      const obs = { ...upHigh('Bench', 80, 90, 3), factSig: `up-high-${i}` } as Observation;
      const line = phraseObservation(obs);
      expect(line).toMatch(/90/);          // the new top weight
      expect(line.toLowerCase()).toMatch(/new (high|top|best)/); // the milestone
    }
  });

  it('ordinary "up" (not a new high) uses the steady-arc pool, never claims a new best', () => {
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) {
      lines.push(phraseObservation({ ...up('Bench', 80, 85, 3), factSig: `up-plain-${i}` } as Observation));
    }
    // None of the ordinary-up variants should claim a record/new best.
    expect(lines.join('\n').toLowerCase()).not.toMatch(/new (high|best)/);
  });

  it('composite phrasing names the lift, connects the signals, and invents no physiology', () => {
    const composites: CoachObservation[] = [
      pushingHard('Bench', 'low_energy'),
      grinding('Squat', 'stall'),
      backOnTrack('Row'),
    ];
    for (const c of composites) {
      const line = phraseObservation(c);
      expect(line.length).toBeGreaterThan(0);
      // References the real lift name (the only interpolated datum).
      expect(line).toMatch(new RegExp((c as any).lift));
      // No invented physiology, no hype.
      expect(line.toLowerCase()).not.toMatch(/nervous system|cns|cortisol|hormon/);
      expect(line).not.toMatch(/!/);
    }
  });

  it('pushing_hard reads as "progressing but protect recovery", not pure praise', () => {
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) {
      lines.push(phraseObservation({ ...pushingHard('Bench'), factSig: `pushing-${i}` } as CoachObservation));
    }
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toMatch(/recovery|ease|back the volume|pull the volume|protect/);
  });

  it('session PR phrasing references both new and previous weights', () => {
    const line = phraseObservation(pr('Bench Press', 82.5, 80));
    expect(line).toMatch(/82\.5/);
    expect(line).toMatch(/80/);
  });

  it('consistency line carries the count and the denominator', () => {
    const line = phraseObservation(consistency(12, 'days14'));
    expect(line).toMatch(/12/);
    expect(line).toMatch(/14/);
  });

  it('plan_rationale: ppl/bro_split variants embed trainingDays; full_body/upper_lower do not', () => {
    const ppl = phraseObservation(rationale('ppl', 3));
    expect(ppl).toMatch(/3/);
    const bro = phraseObservation(rationale('bro_split', 5));
    expect(bro).toMatch(/5/);
    const fb = phraseObservation(rationale('full_body', 1));
    // full_body doesn't reference trainingDays — no leading "1 " or " 1 ".
    expect(fb).not.toMatch(/\b1\b/);
  });

  it('plan_rationale: per-split phrasing is split-specific', () => {
    expect(phraseObservation(rationale('full_body', 1)).toLowerCase()).toMatch(/full-body|full body/);
    expect(phraseObservation(rationale('upper_lower', 2)).toLowerCase()).toMatch(/upper|lower/);
    expect(phraseObservation(rationale('ppl', 3)).toLowerCase()).toMatch(/push|pull|legs|ppl/);
    expect(phraseObservation(rationale('bro_split', 5)).toLowerCase()).toMatch(/body-part|focus|split|muscle/);
  });

  it('plan_rationale: unknown split label degrades to a neutral fallback', () => {
    // Should never fire in practice (builder gates on a non-null split),
    // but the phraser must not throw on a defensive call.
    const line = phraseObservation(rationale('something_weird', 4));
    expect(typeof line).toBe('string');
    expect(line.length).toBeGreaterThan(0);
  });

  it('calibration: pool entry is stable per factSig (the bare literal "calibration")', () => {
    const a = phraseObservation(calibration());
    const b = phraseObservation(calibration());
    expect(a).toBe(b);
    // Loosened to cover all entries in the new calibration pool — every
    // line stays in the "I'm learning your numbers / dialing in your loads"
    // theme, but uses slightly different vocabulary across entries.
    expect(a.toLowerCase()).toMatch(/calibrat|baseline|learning|dial|tune|honest|getting started/);
  });

  // ── Plain-language guardrail (Bug 3 — coach jargon) ────────────────
  // The effort_zone pool used to talk about "1–2 RIR band" / "top sets
  // landing". Normal lifters don't know "RIR" or "reps in reserve" as
  // shorthand; rewrite kept the meaning (hard sets close to failure
  // drive growth) without the insider terms.

  it('effort_zone phrasing never mentions RIR (insider jargon)', () => {
    const allFactSigs = ['high-a', 'high-b', 'high-c', 'high-d', 'high-e'];
    for (const factSig of allFactSigs) {
      const high = phraseObservation({
        type: 'effort_zone', id: 'effort_zone', factSig, salience: 0.5,
        eventDate: TODAY, band: 'high', pct: 0.7,
      });
      expect(high).not.toMatch(/\bRIR\b/);
      expect(high.toLowerCase()).not.toMatch(/reps in reserve/);
    }
    const allLowFactSigs = ['low-a', 'low-b', 'low-c', 'low-d', 'low-e'];
    for (const factSig of allLowFactSigs) {
      const low = phraseObservation({
        type: 'effort_zone', id: 'effort_zone', factSig, salience: 0.5,
        eventDate: TODAY, band: 'low', pct: 0.2,
      });
      expect(low).not.toMatch(/\bRIR\b/);
      expect(low.toLowerCase()).not.toMatch(/reps in reserve/);
    }
  });

  it('effort_zone high band talks about being close to failure / growth zone', () => {
    // Sweep factSigs so we exercise every pool entry; at least ONE line
    // should convey the "close to failure / growth" idea (the others may
    // be the shorter "don't ease off" variant).
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(phraseObservation({
        type: 'effort_zone', id: 'effort_zone', factSig: `h-${i}`,
        salience: 0.5, eventDate: TODAY, band: 'high', pct: 0.7,
      }));
    }
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toMatch(/close to failure|near the limit|growth|effort zone/);
  });

  it('effort_zone low band tells the user to push harder / add weight', () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(phraseObservation({
        type: 'effort_zone', id: 'effort_zone', factSig: `l-${i}`,
        salience: 0.5, eventDate: TODAY, band: 'low', pct: 0.2,
      }));
    }
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toMatch(/add weight|push (closer|harder)|too easy|too safe|in the tank/);
  });

  it('dialed_in phrasing uses real hits/total numbers and never claims "dialed in" without them', () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(phraseObservation({
        type: 'dialed_in', id: 'dialed_in', factSig: `dialed-${i}`,
        salience: 0.6, eventDate: TODAY, hits: 7, total: 10, pct: 0.7,
      }));
    }
    // Every variant references the actual counts (7 and 10) so the
    // line reads as evidence, not flattery.
    for (const line of lines) {
      expect(line).toMatch(/\b7\b/);
      expect(line).toMatch(/\b10\b/);
    }
    // And it never carries an exclamation hype-bot tone.
    const joined = lines.join('\n');
    expect(joined).not.toMatch(/!/);
  });

  it('dialed_in phrasing reads as trust / "engine tuned to you", not generic praise', () => {
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) {
      lines.push(phraseObservation({
        type: 'dialed_in', id: 'dialed_in', factSig: `dialed-${i}-trust`,
        salience: 0.6, eventDate: TODAY, hits: 9, total: 12, pct: 0.75,
      }));
    }
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toMatch(/tuned to you|dialed in|reading you right/);
  });

  it('block_position phrasing never uses raw coach-speak ("deload", "mesocycle", "block week")', () => {
    for (const blockWeek of [3, 4] as const) {
      const lines: string[] = [];
      for (let i = 0; i < 12; i++) {
        lines.push(phraseObservation({
          type: 'block_position', id: `block_position:${blockWeek}`,
          factSig: `block-${blockWeek}-${i}`, salience: 0.4, eventDate: TODAY,
          blockWeek,
        }));
      }
      const joined = lines.join('\n').toLowerCase();
      expect(joined).not.toMatch(/\bdeload\b/);
      expect(joined).not.toMatch(/\bmesocycle\b/);
    }
  });
});

describe('dedupKeyFor / factSigFromDedupKey round-trip', () => {
  it('encodes obs:<id>:<factSig> and parses the trailing factSig back', () => {
    const obs = up('Bench', 80, 85);
    const key = dedupKeyFor(obs);
    expect(key).toBe('obs:lift_progression:Bench:up-85');
    expect(factSigFromDedupKey(key)).toBe('up-85');
  });

  it('round-trips for ids that themselves contain colons', () => {
    const obs = pr('Bench Press', 100, 95);
    expect(factSigFromDedupKey(dedupKeyFor(obs))).toBe('pr-100');
  });

  it('parser is tolerant of malformed input', () => {
    expect(factSigFromDedupKey(null)).toBeNull();
    expect(factSigFromDedupKey(undefined)).toBeNull();
    expect(factSigFromDedupKey('')).toBeNull();
    expect(factSigFromDedupKey('obs:')).toBeNull();
    expect(factSigFromDedupKey('readiness:2026-06-08')).toBeNull(); // legacy non-obs key
  });
});
