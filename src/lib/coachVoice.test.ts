// Tests for the MOUTH. The two invariants that matter:
//   1. Determinism — same factSig → same line, every call, every run.
//   2. Tone — no emoji, no cheerleading. The coach is warm but never a
//      hype-bot. Exclamation marks are allowed on genuine milestones
//      (PRs, new highs) — see the per-type tests below. Non-milestone
//      observations stay flat.
//
// Pool sizes are not asserted (we want to be free to add entries without
// touching tests), but the per-factSig stability IS asserted because that
// stability is the user-visible contract.

import {
  dedupKeyFor,
  factSigFromDedupKey,
  MAX_HERO_LINE_LEN,
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

  it('no phrasing contains an exclamation mark except on milestones (PRs, new highs)', () => {
    // v3: exclamation is allowed on genuine milestones — a PR or a new
    // all-time high. Every other observation type stays flat. This keeps
    // the coach from ever sounding like a hype-bot on ordinary reads.
    const isMilestone = (obs: CoachObservation): boolean =>
      obs.type === 'session_pr' ||
      (obs.type === 'lift_progression' && obs.subtype === 'up' && obs.isAllTimeHigh === true);
    for (const obs of ALL_FIXTURES) {
      const line = phraseObservation(obs);
      if (isMilestone(obs)) continue; // ! allowed here
      expect(line).not.toMatch(/!/);
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

  // ── Hero invariants — every hero-eligible line must fit AND act ────
  // The dashboard hero shows ONE line at editorial scale. Two contracts:
  //   1. ≤ MAX_HERO_LINE_LEN (90 chars) — the layout depends on it.
  //   2. Carries a forward directive — where you are AND what to do today.
  //      A purely descriptive line ("Bench hit a new high.") is rejected;
  //      every entry must include at least one second-person directive
  //      verb ("hit/keep/hold/push/cement/lock/bank/ease/pull/build/find/
  //      force/take/show/run/log/trust/follow/get/add/drop/move/protect/
  //      recover/skip/work/empty/dial/stay/bring/make/count/start/come/
  //      don't") or a "today" / "next time" anchor. The test sweeps a
  //      wide factSig range per type so every pool entry is exercised.

  function sweepFactSigs<T extends CoachObservation>(obs: T, n: number): T[] {
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ ...obs, factSig: `${obs.factSig}-sweep-${i}` } as T);
    }
    return out;
  }

  // Lifted from the BRAIN's hero tier (anything that can land in the
  // pre-workout dashboard's single slot). Filler-tier observations
  // (briefing_fallback, rest_day, plan_rationale, calibration) are
  // included too — they CAN surface on a quiet day, so they're held to
  // the same length+directive bar.
  const HERO_ELIGIBLE: CoachObservation[] = [
    ...sweepFactSigs(up('Bench', 80, 142.5, 4), 6),
    ...sweepFactSigs(upHigh('Bench', 80, 142.5, 4), 6),
    ...sweepFactSigs(stall('Squat', 142.5, 4), 6),
    ...sweepFactSigs(comebackLift('Row', 42), 6),
    ...sweepFactSigs(pr('Bench Press', 142.5, 140), 6),
    ...sweepFactSigs(consistency(28, 'days28'), 6),
    ...sweepFactSigs({
      type: 'block_position', id: 'block_position:3',
      factSig: 'block-3', salience: 0.7, eventDate: TODAY, blockWeek: 3,
    }, 6),
    ...sweepFactSigs({
      type: 'block_position', id: 'block_position:4',
      factSig: 'block-4', salience: 0.95, eventDate: TODAY, blockWeek: 4,
    }, 6),
    ...sweepFactSigs(effortHigh(0.7), 6),
    ...sweepFactSigs({
      type: 'effort_zone', id: 'effort_zone', factSig: 'effort-low',
      salience: 0.5, eventDate: TODAY, band: 'low', pct: 0.2,
    }, 6),
    ...sweepFactSigs({
      type: 'dialed_in', id: 'dialed_in', factSig: 'dialed-7',
      salience: 0.6, eventDate: TODAY, hits: 9, total: 12, pct: 0.75,
    }, 6),
    ...sweepFactSigs(comeback(42), 6),
    ...sweepFactSigs(pushingHard('Bench', 'low_energy'), 6),
    ...sweepFactSigs(grinding('Squat', 'stall'), 6),
    ...sweepFactSigs(backOnTrack('Row'), 6),
    ...sweepFactSigs({
      type: 'rest_day', id: 'rest_day', factSig: `rest-${TODAY}`,
      salience: 0.1, eventDate: TODAY,
    }, 6),
    ...sweepFactSigs({
      type: 'briefing_fallback', id: 'briefing_fallback',
      factSig: `brief-${TODAY}`, salience: 0.1, eventDate: TODAY,
      workoutType: 'Push', exerciseCount: 6,
    }, 6),
    ...sweepFactSigs(rationale('full_body', 1), 6),
    ...sweepFactSigs(rationale('upper_lower', 2), 6),
    ...sweepFactSigs(rationale('ppl', 4), 6),
    ...sweepFactSigs(rationale('bro_split', 6), 6),
    ...sweepFactSigs(calibration(), 6),
  ];

  it('every hero-eligible line is ≤ MAX_HERO_LINE_LEN characters', () => {
    expect(MAX_HERO_LINE_LEN).toBe(130);
    for (const obs of HERO_ELIGIBLE) {
      const line = phraseObservation(obs);
      // Tag failing line in the message so a regression is debuggable.
      if (line.length > MAX_HERO_LINE_LEN) {
        throw new Error(
          `hero line over ${MAX_HERO_LINE_LEN} chars (${line.length}): "${line}" [obs.type=${obs.type}]`,
        );
      }
    }
  });

  it('every hero-eligible line carries a directive (read + what to do)', () => {
    // Curated directive vocabulary — second-person imperatives + the
    // "today" / "next time" temporal anchors + the question mark (v3
    // allows rhetorical questions as a forward cue). A line that matches
    // NONE of these is pure description and fails the hero contract.
    const DIRECTIVE_RE = /\b(today|tonight|next time|don't|don’t|hit|keep|hold|push|cement|lock|bank|ease|pull|build|find|force|take|show|run|log|trust|follow|get|add|drop|move|protect|recover|skip|work|empty|dial|stay|bring|make|count|start|come|ride|tune|train|lighten|catch up|sleep|rest|reset|sharpen|nudge|tap)\b/i;
    for (const obs of HERO_ELIGIBLE) {
      const line = phraseObservation(obs);
      // A question mark counts as a forward cue in v3 (warmer voice).
      if (!DIRECTIVE_RE.test(line) && !line.includes('?')) {
        throw new Error(
          `hero line missing forward directive: "${line}" [obs.type=${obs.type}]`,
        );
      }
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

  it('plan_rationale: a stored priority WINS over goal and split copy', () => {
    // Compound priority surfaces the compound-rotation template.
    const benchObs: Observation = {
      type: 'plan_rationale',
      id: 'plan_rationale:ppl',
      factSig: 'rationale-ppl-gstrength-pbench',
      salience: 0.55,
      eventDate: TODAY,
      split: 'ppl',
      trainingDays: 3,
      goal: 'strength',
      priority: 'bench',
    };
    const benchLine = phraseObservation(benchObs).toLowerCase();
    expect(benchLine).toMatch(/bench/);
    // Bucket priority surfaces the bucket-rotation template (one of the
    // muscle filter labels we expose in onboarding).
    const legsObs: Observation = {
      type: 'plan_rationale',
      id: 'plan_rationale:ppl',
      factSig: 'rationale-ppl-gmuscle-plegs',
      salience: 0.55,
      eventDate: TODAY,
      split: 'ppl',
      trainingDays: 3,
      goal: 'muscle',
      priority: 'legs',
    };
    const legsLine = phraseObservation(legsObs).toLowerCase();
    expect(legsLine).toMatch(/legs/);
  });

  it('plan_rationale: a stored goal (no priority) selects the goal pool', () => {
    const strengthObs: Observation = {
      type: 'plan_rationale',
      id: 'plan_rationale:ppl',
      factSig: 'rationale-ppl-gstrength-px',
      salience: 0.55,
      eventDate: TODAY,
      split: 'ppl',
      trainingDays: 3,
      goal: 'strength',
      priority: null,
    };
    const muscleObs: Observation = {
      ...strengthObs,
      factSig: 'rationale-ppl-gmuscle-px',
      goal: 'muscle',
    };
    const generalObs: Observation = {
      ...strengthObs,
      factSig: 'rationale-ppl-ggeneral-px',
      goal: 'general',
    };
    const s = phraseObservation(strengthObs).toLowerCase();
    const m = phraseObservation(muscleObs).toLowerCase();
    const g = phraseObservation(generalObs).toLowerCase();
    // Goal pools carry lane-correct language. Strength emphasizes the
    // heavy compound and "reps in the tank"; muscle emphasizes rep climb
    // and volume; general (passthrough lane) stays generic — no dose
    // directive since the lane doesn't shape the dose.
    expect(s).toMatch(/strength|bar|heavy|heavier|tank/);
    expect(m).toMatch(/size|growth|grow|muscle|rep|volume/);
    expect(g).toMatch(/general|progress|steady|long arc|long-arc|long game/);
    // The three pools must produce distinguishable lines for the same split.
    expect(new Set([s, m, g]).size).toBeGreaterThan(1);
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
    // Extended to weeks 1–4 in v8 (muscle-lane ramp voice). wk1/2 pools
    // fire only for the muscle lane, so the observation carries goal.
    for (const blockWeek of [1, 2, 3, 4] as const) {
      const goal = blockWeek === 1 || blockWeek === 2 ? 'muscle' as const : null;
      const lines: string[] = [];
      for (let i = 0; i < 12; i++) {
        lines.push(phraseObservation({
          type: 'block_position', id: `block_position:${blockWeek}`,
          factSig: `block-${blockWeek}-${i}`, salience: 0.4, eventDate: TODAY,
          blockWeek, goal,
        }));
      }
      const joined = lines.join('\n').toLowerCase();
      expect(joined).not.toMatch(/\bdeload\b/);
      expect(joined).not.toMatch(/\bmesocycle\b/);
    }
  });

  it('muscle-lane block_position wk1 speaks to the INTRO of the ramp', () => {
    // The whole point of wk1 copy: the SETS climb from here, don't push
    // loads on a light-volume week. Every entry should communicate this
    // (via one of "ramp"/"climb"/"stack"/"volume"/"low"/"light"/"intro"/"grow").
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(phraseObservation({
        type: 'block_position', id: 'block_position:1',
        factSig: `block-1-gmuscle-${i}`, salience: 0.5, eventDate: TODAY,
        blockWeek: 1, goal: 'muscle',
      }));
    }
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toMatch(/ramp|climb|stack|volume|light|intro|grow|low/);
    // Under 130 chars per line (hero contract).
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(130);
  });

  it('muscle-lane block_position wk2 speaks to the BUILD (more sets, hold loads)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(phraseObservation({
        type: 'block_position', id: 'block_position:2',
        factSig: `block-2-gmuscle-${i}`, salience: 0.55, eventDate: TODAY,
        blockWeek: 2, goal: 'muscle',
      }));
    }
    const joined = lines.join('\n').toLowerCase();
    // Every wk2 line references the volume climb or the "more sets"
    // beat — that's the whole reason this pool exists.
    expect(joined).toMatch(/climb|volume|more sets|extra sets|build|ramp/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(130);
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
