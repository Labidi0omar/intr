// Unit tests for the BRAIN. Every builder's boundary cases live here so the
// selector + voice can take its inputs as a given. factSig values are
// asserted explicitly because they ARE the dedup primitive — if a
// refactor changes the encoding, this test fails and the memory guard
// would silently re-fire spoken facts.

import {
  buildBlockPosition,
  buildBriefingFallback,
  buildCalibration,
  buildComeback,
  buildConsistency,
  buildEffortZone,
  buildDialedIn,
  buildLiftProgression,
  buildPlanRationale,
  buildRestDay,
  buildSessionPr,
  buildPushingHard,
  buildGrinding,
  buildBackOnTrack,
  isCompositeObservation,
  computeGapDays,
  deriveObservations,
  selectTopObservations,
  type CoachObservation,
  type LiftFact,
  type Observation,
  type ObservationsInput,
} from './coachObservations';

const TODAY = '2026-06-10';

// ── liftProgression ─────────────────────────────────────────────────────

describe('buildLiftProgression', () => {
  it('detects "up N" when the last N (>=2) sessions strictly increase', () => {
    const obs = buildLiftProgression(
      'Bench',
      [
        { topKg: 80, date: '2026-06-01' },
        { topKg: 82.5, date: '2026-06-04' },
        { topKg: 85, date: '2026-06-08' },
      ],
      TODAY,
    );
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('lift_progression');
    expect(obs!.subtype).toBe('up');
    expect(obs!.factSig).toBe('up-85');
    expect(obs!.salience).toBe(0.9);
    if (obs!.subtype === 'up') {
      expect(obs!.from).toBe(80);
      expect(obs!.to).toBe(85);
      expect(obs!.span).toBe(3);
    }
  });

  it('reports the trailing run only — earlier non-monotonic history is ignored', () => {
    const obs = buildLiftProgression(
      'Squat',
      [
        { topKg: 90, date: '2026-05-20' },
        { topKg: 85, date: '2026-05-25' }, // dip
        { topKg: 90, date: '2026-05-30' },
        { topKg: 95, date: '2026-06-05' },
      ],
      TODAY,
    );
    expect(obs?.subtype).toBe('up');
    if (obs?.subtype === 'up') {
      expect(obs.span).toBe(3); // 85 → 90 → 95
      expect(obs.from).toBe(85);
      expect(obs.to).toBe(95);
    }
  });

  it('detects "stall" — last N (>=2) sessions at exactly the same weight', () => {
    const obs = buildLiftProgression(
      'Deadlift',
      [
        { topKg: 100, date: '2026-05-25' },
        { topKg: 100, date: '2026-05-30' },
        { topKg: 100, date: '2026-06-05' },
      ],
      TODAY,
    );
    expect(obs?.subtype).toBe('stall');
    expect(obs!.factSig).toBe('stall-100-3');
    expect(obs!.salience).toBe(0.8);
  });

  it('a fresh stall (one extra equal session) advances factSig — re-fires under dedup', () => {
    const two = buildLiftProgression(
      'Deadlift',
      [
        { topKg: 100, date: '2026-06-01' },
        { topKg: 100, date: '2026-06-05' },
      ],
      TODAY,
    );
    const three = buildLiftProgression(
      'Deadlift',
      [
        { topKg: 100, date: '2026-06-01' },
        { topKg: 100, date: '2026-06-05' },
        { topKg: 100, date: '2026-06-08' },
      ],
      TODAY,
    );
    expect(two!.factSig).toBe('stall-100-2');
    expect(three!.factSig).toBe('stall-100-3');
    expect(three!.factSig).not.toBe(two!.factSig);
  });

  it('detects "comeback" — fresh session after a 14+ day gap from the previous one', () => {
    const obs = buildLiftProgression(
      'Row',
      [
        { topKg: 60, date: '2026-04-01' },
        { topKg: 65, date: '2026-04-15' },
        // 56-day gap, then a fresh session today.
        { topKg: 70, date: TODAY },
      ],
      TODAY,
    );
    expect(obs?.subtype).toBe('comeback');
    if (obs?.subtype === 'comeback') {
      expect(obs.days).toBe(56);
      expect(obs.factSig).toBe('comeback-56');
      expect(obs.salience).toBe(0.7);
    }
  });

  it('returns null on a dormant lift (last session 14+ days ago, nothing fresh)', () => {
    const obs = buildLiftProgression(
      'Row',
      [
        { topKg: 60, date: '2026-04-01' },
        { topKg: 65, date: '2026-04-08' },
        { topKg: 70, date: '2026-04-15' },
      ],
      TODAY, // 56 days after last
    );
    expect(obs).toBeNull();
  });

  it('"up" wins over "stall" via salience — the builder picks one state', () => {
    // Equal-weight prefix + recent strictly-increasing tail.
    const obs = buildLiftProgression(
      'Press',
      [
        { topKg: 40, date: '2026-05-25' },
        { topKg: 40, date: '2026-05-30' },
        { topKg: 42.5, date: '2026-06-05' },
        { topKg: 45, date: '2026-06-08' },
      ],
      TODAY,
    );
    expect(obs?.subtype).toBe('up');
  });

  it('returns null when only one session of data is available', () => {
    expect(
      buildLiftProgression('Curl', [{ topKg: 15, date: '2026-06-05' }], TODAY),
    ).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(buildLiftProgression('', [], TODAY)).toBeNull();
    expect(buildLiftProgression('Bench', [], TODAY)).toBeNull();
  });

  // ── Continuity facts (the arc, not just the latest delta) ──────────────

  it('span carries the run length and isAllTimeHigh is true when the latest top is a new high', () => {
    const obs = buildLiftProgression(
      'Bench',
      [
        { topKg: 80, date: '2026-06-01' },
        { topKg: 82.5, date: '2026-06-04' },
        { topKg: 85, date: '2026-06-08' },
      ],
      TODAY,
    );
    expect(obs?.subtype).toBe('up');
    if (obs?.subtype === 'up') {
      expect(obs.span).toBe(3); // three sessions in the rising run
      expect(obs.isAllTimeHigh).toBe(true); // 85 is the highest on record here
    }
  });

  it('isAllTimeHigh is FALSE when an earlier session was heavier (climbing, but not a new best)', () => {
    const obs = buildLiftProgression(
      'Squat',
      [
        { topKg: 100, date: '2026-05-20' }, // old high, still the max
        { topKg: 80, date: '2026-05-25' },
        { topKg: 85, date: '2026-05-30' },
        { topKg: 90, date: '2026-06-05' }, // climbing run 80→85→90 but < 100
      ],
      TODAY,
    );
    expect(obs?.subtype).toBe('up');
    if (obs?.subtype === 'up') {
      expect(obs.span).toBe(3);
      expect(obs.to).toBe(90);
      expect(obs.isAllTimeHigh).toBe(false);
    }
  });
});

// ── sessionPr ───────────────────────────────────────────────────────────

describe('buildSessionPr', () => {
  it('fires when newKg > prevKg', () => {
    const obs = buildSessionPr('Bench Press', 82.5, 80, TODAY);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('session_pr');
    expect(obs!.factSig).toBe('pr-82.5');
    // 0.97 — a real PR is the headline of the day, above block_position
    // (0.95) so it leads on the day it actually happens.
    expect(obs!.salience).toBe(0.97);
  });

  it('null on equal or lower weight', () => {
    expect(buildSessionPr('Bench', 80, 80, TODAY)).toBeNull();
    expect(buildSessionPr('Bench', 79, 80, TODAY)).toBeNull();
  });

  it('null on non-finite weights (first-time lift caller passes NaN — explicit contract)', () => {
    expect(buildSessionPr('Bench', 80, Number.NaN, TODAY)).toBeNull();
    expect(buildSessionPr('Bench', Number.NaN, 70, TODAY)).toBeNull();
  });

  it('null on empty lift', () => {
    expect(buildSessionPr('   ', 80, 70, TODAY)).toBeNull();
  });
});

// ── consistency ─────────────────────────────────────────────────────────

describe('buildConsistency', () => {
  it('fires at 12 of last 14', () => {
    const obs = buildConsistency(12, 14, TODAY);
    expect(obs?.factSig).toBe('consist-12of14');
    expect(obs?.metric).toBe('days14');
    expect(obs?.salience).toBe(0.7);
  });

  it('factSig advances at 13/14 vs 12/14 — re-fires when count climbs', () => {
    expect(buildConsistency(12, 14, TODAY)!.factSig).toBe('consist-12of14');
    expect(buildConsistency(13, 14, TODAY)!.factSig).toBe('consist-13of14');
  });

  it('falls through to days28 when 14d threshold misses but 28d hits', () => {
    const obs = buildConsistency(8, 21, TODAY);
    expect(obs?.metric).toBe('days28');
    expect(obs?.factSig).toBe('consist-21of28');
  });

  it('null on quiet weeks', () => {
    expect(buildConsistency(5, 9, TODAY)).toBeNull();
    expect(buildConsistency(0, 0, TODAY)).toBeNull();
  });
});

// ── blockPosition ───────────────────────────────────────────────────────

describe('buildBlockPosition', () => {
  it('fires on week 3 and week 4 only', () => {
    expect(buildBlockPosition(3, TODAY)!.factSig).toBe('block-3');
    expect(buildBlockPosition(4, TODAY)!.factSig).toBe('block-4');
  });

  it('null on weeks 1, 2, null, undefined, out-of-range', () => {
    expect(buildBlockPosition(1, TODAY)).toBeNull();
    expect(buildBlockPosition(2, TODAY)).toBeNull();
    expect(buildBlockPosition(null, TODAY)).toBeNull();
    expect(buildBlockPosition(5, TODAY)).toBeNull();
    expect(buildBlockPosition(0, TODAY)).toBeNull();
  });

  it('block_position outranks ordinary progression but NOT a real PR', () => {
    // Pinned ordering: session_pr (0.97) > block_position (0.95) >
    // lift_progression:up (0.9). A future tweak that breaks this
    // contract should fail loudly here.
    const block = buildBlockPosition(3, TODAY)!;
    expect(block.salience).toBeGreaterThan(0.9);  // ordinary progression
    expect(block.salience).toBeGreaterThan(0.8);  // stall
    expect(block.salience).toBeGreaterThan(0.7);  // consistency / comeback
    expect(block.salience).toBeGreaterThanOrEqual(0.95);
    expect(block.salience).toBeLessThan(0.97);    // a real PR still leads
  });

  it('selectTopObservations: session_pr leads block_position on PR day', () => {
    // The PR was earned TODAY — for that day it must lead the dashboard.
    const block = buildBlockPosition(3, TODAY)!;
    const pr: Observation = {
      type: 'session_pr',
      id: 'session_pr:Bench',
      factSig: 'pr-85',
      salience: 0.97,
      eventDate: TODAY,
      lift: 'Bench',
      newKg: 85,
      prevKg: 82.5,
    };
    const picked = selectTopObservations([pr, block], { recentFactSigs: new Set() });
    expect(picked[0].type).toBe('session_pr');
  });

  it('selectTopObservations: block_position leads ordinary lift_progression on non-PR day', () => {
    const block = buildBlockPosition(3, TODAY)!;
    const liftUp: Observation = {
      type: 'lift_progression',
      subtype: 'up',
      id: 'lift_progression:Bench',
      factSig: 'up-85',
      salience: 0.9,
      eventDate: TODAY,
      lift: 'Bench',
      from: 80,
      to: 85,
      span: 3,
    };
    const picked = selectTopObservations([liftUp, block], { recentFactSigs: new Set() });
    expect(picked[0].type).toBe('block_position');
  });
});

// ── effortZone ──────────────────────────────────────────────────────────

describe('buildEffortZone', () => {
  it('"high" at >=60% of recent rated sets in 1-2 RIR', () => {
    const obs = buildEffortZone({ hits: 7, total: 10 }, TODAY);
    expect(obs?.band).toBe('high');
    expect(obs?.factSig).toBe('effort-high');
    expect(obs?.salience).toBe(0.5);
  });

  it('"low" at <30%', () => {
    const obs = buildEffortZone({ hits: 2, total: 10 }, TODAY);
    expect(obs?.band).toBe('low');
    expect(obs?.factSig).toBe('effort-low');
  });

  it('null in the middle band (30..60%)', () => {
    expect(buildEffortZone({ hits: 4, total: 10 }, TODAY)).toBeNull();
    expect(buildEffortZone({ hits: 5, total: 10 }, TODAY)).toBeNull();
  });

  it('null on too-small samples (< 5 rated sets)', () => {
    expect(buildEffortZone({ hits: 4, total: 4 }, TODAY)).toBeNull();
    expect(buildEffortZone({ hits: 0, total: 0 }, TODAY)).toBeNull();
  });
});

// ── dialedIn ────────────────────────────────────────────────────────────

describe('buildDialedIn', () => {
  it('fires when total ≥ 8 and hit rate ≥ 0.7', () => {
    const obs = buildDialedIn({ hits: 7, total: 10 }, TODAY);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('dialed_in');
    expect(obs!.hits).toBe(7);
    expect(obs!.total).toBe(10);
    expect(obs!.pct).toBeCloseTo(0.7, 5);
    expect(obs!.salience).toBe(0.6);
  });

  it('factSig is bucketed to a one-decimal hit-rate (does not re-speak on noise)', () => {
    // 72% and 75% both round to a single bucket → same factSig.
    const a = buildDialedIn({ hits: 18, total: 25 }, TODAY)!; // 0.72 → bucket 7
    const b = buildDialedIn({ hits: 15, total: 20 }, TODAY)!; // 0.75 → bucket 8
    const c = buildDialedIn({ hits: 17, total: 23 }, TODAY)!; // 0.739 → bucket 7
    expect(a.factSig).toBe('dialed-7');
    expect(b.factSig).toBe('dialed-8');
    expect(c.factSig).toBe(a.factSig); // same bucket → memory guard dedups
  });

  it('does NOT fire below the hit-rate floor (engine still calibrating)', () => {
    // Honesty rule: 8/10 sets but only 4 in the zone → 40% → no claim.
    expect(buildDialedIn({ hits: 4, total: 10 }, TODAY)).toBeNull();
    expect(buildDialedIn({ hits: 6, total: 10 }, TODAY)).toBeNull(); // 60%
    // Right at the floor.
    expect(buildDialedIn({ hits: 7, total: 10 }, TODAY)).not.toBeNull();
  });

  it('does NOT fire below the volume floor (< 8 rated sets)', () => {
    // 5 of 5 = 100% but only 5 sets — not enough signal to call it.
    expect(buildDialedIn({ hits: 5, total: 5 }, TODAY)).toBeNull();
    expect(buildDialedIn({ hits: 7, total: 7 }, TODAY)).toBeNull();
    // Right at the boundary.
    expect(buildDialedIn({ hits: 8, total: 8 }, TODAY)).not.toBeNull();
  });

  it('handles empty / malformed counts safely (no division-by-zero)', () => {
    expect(buildDialedIn({ hits: 0, total: 0 }, TODAY)).toBeNull();
    expect(buildDialedIn({ hits: 0, total: 8 }, TODAY)).toBeNull();
  });

  it('outranks ordinary effort_zone in the selector (salience 0.6 > 0.5)', () => {
    const dialed = buildDialedIn({ hits: 9, total: 10 }, TODAY)!;
    const effort = buildEffortZone({ hits: 9, total: 10 }, TODAY)!;
    expect(dialed.salience).toBeGreaterThan(effort.salience);
  });

  // ── No overlap with cold-start calibration ─────────────────────────
  // calibration fires while totalCompleted < 6 (each session typically
  // produces 4–6 rated sets, so total rated sets is well under 8 in
  // that window). dialed_in requires total ≥ 8. The volume floors
  // therefore make co-firing structurally impossible for any realistic
  // user; this test pins that contract.

  it('cannot co-fire with calibration: dialed_in requires more rated sets than calibration tolerates', () => {
    // Calibration in-window: brand-new user, totalCompleted = 5.
    const cal = buildCalibration(7, 5, TODAY);
    expect(cal).not.toBeNull();
    // Even if a single session somehow had 7 rated sets, total < 8 keeps
    // dialed_in silent.
    expect(buildDialedIn({ hits: 6, total: 7 }, TODAY)).toBeNull();
  });
});

// ── computeGapDays (the helper that gates the comeback observation) ────
//
// This is the false-positive guard that shipped without coverage and got
// caught with a foot-gun for every new user (the launch reality is mostly
// new users, so "back after N missed sessions" fired as the first message
// for nearly everyone). Each branch below is one corner of the guard.

describe('computeGapDays', () => {
  // Shared "established" fixture: 4 weeks of history, 4 days since last,
  // training 3 days a week, only 1 of last 14 trained. Tests below mutate
  // ONE input at a time to drive each guard.
  const established = {
    firstSessionDaysAgo: 28,
    totalCompleted: 12,
    daysSinceLast: 4,
    trainingDays: 3,
    trainedDays14: 1,
  };

  it('returns 0 when the user has no completed sessions at all', () => {
    expect(
      computeGapDays({
        firstSessionDaysAgo: 0,
        totalCompleted: 0,
        daysSinceLast: Number.POSITIVE_INFINITY,
        trainingDays: 3,
        trainedDays14: 0,
      }),
    ).toBe(0);
  });

  it('new user, 4 days old, 2 sessions → 0 (baseline not established)', () => {
    expect(
      computeGapDays({
        firstSessionDaysAgo: 4,
        totalCompleted: 2,
        daysSinceLast: 2,
        trainingDays: 3,
        trainedDays14: 2,
      }),
    ).toBe(0);
  });

  it('totalCompleted just below 3 → 0', () => {
    expect(computeGapDays({ ...established, totalCompleted: 2 })).toBe(0);
  });

  it('firstSessionDaysAgo just below 14 → 0', () => {
    expect(computeGapDays({ ...established, firstSessionDaysAgo: 13 })).toBe(0);
  });

  it('established user, trained 2 days ago → 0 (no recent absence)', () => {
    expect(computeGapDays({ ...established, daysSinceLast: 2 })).toBe(0);
  });

  it('established user, trained 3 days ago → 0 (boundary: <4 disables)', () => {
    expect(computeGapDays({ ...established, daysSinceLast: 3 })).toBe(0);
  });

  it('established user, trained 4 days ago, well below expected → fires (>=3)', () => {
    // expected = round(3/7 * min(14, 28)) = round(6) = 6. trainedDays14 = 1.
    // gapDays = 5 → buildComeback floor is 3, so this fires.
    const gap = computeGapDays({ ...established, daysSinceLast: 4 });
    expect(gap).toBeGreaterThanOrEqual(3);
    expect(gap).toBe(5);
  });

  it('established user, last session 8 days ago, well below expected → fires', () => {
    const gap = computeGapDays({
      firstSessionDaysAgo: 60,
      totalCompleted: 20,
      daysSinceLast: 8,
      trainingDays: 4,
      trainedDays14: 1,
    });
    // expected = round(4/7 * 14) = round(8) = 8. gap = 7.
    expect(gap).toBe(7);
  });

  it('user exactly 14 days old → expected prorated to lookback=14, no phantom gap', () => {
    // First crossed-the-line case the spec calls out. With trainingDays=3,
    // expected = round(3/7 * 14) = 6. If trainedDays14 = 6, gap is 0.
    expect(
      computeGapDays({
        firstSessionDaysAgo: 14,
        totalCompleted: 6,
        daysSinceLast: 0,
        trainingDays: 3,
        trainedDays14: 6,
      }),
    ).toBe(0);
  });

  it('prorates expected by min(14, firstSessionDaysAgo)', () => {
    // 21d history, trained 1x/wk → expected = round(1/7 * 14) = 2.
    expect(
      computeGapDays({
        firstSessionDaysAgo: 21,
        totalCompleted: 3,
        daysSinceLast: 7,
        trainingDays: 1,
        trainedDays14: 0,
      }),
    ).toBe(2);
  });

  it('trainingDays=0 → 0 (rest-only user has nothing to miss)', () => {
    expect(computeGapDays({ ...established, trainingDays: 0 })).toBe(0);
  });

  it('established user fully on-schedule → 0 (not a comeback)', () => {
    // trainingDays=3, trainedDays14=6 → expected−actual = 0.
    expect(
      computeGapDays({
        firstSessionDaysAgo: 28,
        totalCompleted: 12,
        daysSinceLast: 5,
        trainingDays: 3,
        trainedDays14: 6,
      }),
    ).toBe(0);
  });

  it('coerces malformed inputs to 0 rather than throwing', () => {
    expect(
      computeGapDays({
        firstSessionDaysAgo: Number.NaN as unknown as number,
        totalCompleted: -1 as unknown as number,
        daysSinceLast: Number.NaN as unknown as number,
        trainingDays: -3 as unknown as number,
        trainedDays14: Number.NaN as unknown as number,
      }),
    ).toBe(0);
  });
});

// ── comeback (whole-training) ──────────────────────────────────────────

describe('buildComeback', () => {
  it('fires at gapDays >= 3 (missed scheduled days, NOT raw calendar)', () => {
    const obs = buildComeback(4, TODAY);
    expect(obs?.factSig).toBe('gap-4');
    expect(obs?.salience).toBe(1.0);
  });

  it('null below threshold — closes the rest-day false-positive', () => {
    expect(buildComeback(0, TODAY)).toBeNull();
    expect(buildComeback(2, TODAY)).toBeNull();
  });

  it('factSig advances with the count so a worsening gap re-fires', () => {
    expect(buildComeback(3, TODAY)!.factSig).toBe('gap-3');
    expect(buildComeback(5, TODAY)!.factSig).toBe('gap-5');
  });
});

// ── briefingFallback ────────────────────────────────────────────────────

describe('buildBriefingFallback', () => {
  it('only fires on a training day with at least one lift', () => {
    expect(buildBriefingFallback('Push', 5, TODAY)?.factSig).toBe(`brief-${TODAY}`);
    expect(buildBriefingFallback('', 5, TODAY)).toBeNull();
    expect(buildBriefingFallback('Push', 0, TODAY)).toBeNull();
    expect(buildBriefingFallback(null, 5, TODAY)).toBeNull();
  });

  it('carries salience below the selector floor', () => {
    expect(buildBriefingFallback('Push', 5, TODAY)?.salience).toBe(0.1);
  });
});

describe('buildRestDay', () => {
  it('fires on a rest day (null/empty/"Rest" workoutType with 0 exercises)', () => {
    expect(buildRestDay(null, 0, TODAY)?.type).toBe('rest_day');
    expect(buildRestDay('', 0, TODAY)?.type).toBe('rest_day');
    expect(buildRestDay('Rest', 0, TODAY)?.type).toBe('rest_day');
    expect(buildRestDay('rest', 0, TODAY)?.type).toBe('rest_day'); // case-insensitive
    expect(buildRestDay(null, 0, TODAY)?.factSig).toBe(`rest-${TODAY}`);
  });

  it('does NOT fire on a training day (it is the briefing fallback that fires there)', () => {
    expect(buildRestDay('Push', 5, TODAY)).toBeNull();
    expect(buildRestDay('Legs', 6, TODAY)).toBeNull();
    // 'Rest' with exercises is not a rest day either.
    expect(buildRestDay('Rest', 3, TODAY)).toBeNull();
  });

  it('is mutually exclusive with the briefing fallback (never both on one day)', () => {
    // Rest day → rest_day only.
    expect(buildRestDay(null, 0, TODAY)).not.toBeNull();
    expect(buildBriefingFallback(null, 0, TODAY)).toBeNull();
    // Training day → briefing only.
    expect(buildRestDay('Push', 5, TODAY)).toBeNull();
    expect(buildBriefingFallback('Push', 5, TODAY)).not.toBeNull();
  });

  it('carries filler salience (0.1) — outranked by every real signal', () => {
    expect(buildRestDay(null, 0, TODAY)?.salience).toBe(0.1);
  });
});

// ── plan_rationale (cold-start: explain the split choice) ──────────────

describe('buildPlanRationale', () => {
  it('fires while ramping (totalCompleted < 8) and a split is known', () => {
    const obs = buildPlanRationale('ppl', 3, 4, TODAY);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('plan_rationale');
    expect(obs!.factSig).toBe('rationale-ppl');
    expect(obs!.salience).toBe(0.55);
    expect(obs!.trainingDays).toBe(3);
    expect(obs!.split).toBe('ppl');
  });

  it('auto-retires past 8 completed sessions', () => {
    expect(buildPlanRationale('ppl', 3, 8, TODAY)).toBeNull();
    expect(buildPlanRationale('ppl', 3, 20, TODAY)).toBeNull();
  });

  it('null on missing split (the user has no preferred_split yet)', () => {
    expect(buildPlanRationale(null, 3, 0, TODAY)).toBeNull();
    expect(buildPlanRationale('', 3, 0, TODAY)).toBeNull();
  });

  it('factSig is per-split — a returning user who switches splits re-hears the rationale', () => {
    const a = buildPlanRationale('upper_lower', 2, 5, TODAY)!;
    const b = buildPlanRationale('ppl', 3, 5, TODAY)!;
    expect(a.factSig).toBe('rationale-upper_lower');
    expect(b.factSig).toBe('rationale-ppl');
    expect(a.factSig).not.toBe(b.factSig);
  });

  it('clamps trainingDays to 0..7 defensively', () => {
    expect(buildPlanRationale('ppl', 0, 0, TODAY)!.trainingDays).toBe(0);
    expect(buildPlanRationale('ppl', 99, 0, TODAY)!.trainingDays).toBe(7);
    expect(buildPlanRationale('ppl', null, 0, TODAY)!.trainingDays).toBe(0);
  });
});

// ── calibration (cold-start: "I'm learning you") ───────────────────────

describe('buildCalibration', () => {
  it('fires for a brand-new user (firstSessionDaysAgo null)', () => {
    const obs = buildCalibration(null, 0, TODAY);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('calibration');
    expect(obs!.factSig).toBe('calibration');
    expect(obs!.salience).toBe(0.6);
  });

  it('fires inside the 2-week / 6-session window', () => {
    expect(buildCalibration(0, 0, TODAY)).not.toBeNull();
    expect(buildCalibration(7, 3, TODAY)).not.toBeNull();
    expect(buildCalibration(13, 5, TODAY)).not.toBeNull();
  });

  it('auto-retires past 14 days', () => {
    expect(buildCalibration(14, 0, TODAY)).toBeNull();
    expect(buildCalibration(30, 0, TODAY)).toBeNull();
  });

  it('auto-retires past 6 completed sessions even within the first 14 days', () => {
    expect(buildCalibration(10, 6, TODAY)).toBeNull();
    expect(buildCalibration(10, 12, TODAY)).toBeNull();
  });

  it('factSig is the bare literal "calibration" (once-only semantics via the memory guard)', () => {
    expect(buildCalibration(null, 0, TODAY)!.factSig).toBe('calibration');
    expect(buildCalibration(5, 2, TODAY)!.factSig).toBe('calibration');
  });
});

// ── deriveObservations + selectTopObservations ─────────────────────────

function baseInput(overrides: Partial<ObservationsInput> = {}): ObservationsInput {
  return {
    todayIso: TODAY,
    liftSessions: {},
    sessionPrs: [],
    trainedDays14: 0,
    trainedDays28: 0,
    blockWeek: null,
    effortZone: { hits: 0, total: 0 },
    gapDays: 0,
    todayWorkoutType: null,
    todayExerciseCount: 0,
    // Cold-start fields default to "established user, no cold-start
    // observations should fire" so the existing tests above stay quiet.
    split: null,
    trainingDays: null,
    firstSessionDaysAgo: 60,
    totalCompleted: 20,
    ...overrides,
  };
}

describe('deriveObservations', () => {
  it('emits one observation per active lift plus the others', () => {
    const obs = deriveObservations(
      baseInput({
        liftSessions: {
          Bench: [
            { topKg: 80, date: '2026-06-01' },
            { topKg: 82.5, date: '2026-06-05' },
          ],
          Squat: [
            { topKg: 100, date: '2026-06-01' },
            { topKg: 100, date: '2026-06-05' },
          ],
        },
        trainedDays14: 12,
        trainedDays28: 22,
        blockWeek: 3,
        effortZone: { hits: 7, total: 10 },
        gapDays: 0,
        todayWorkoutType: 'Push',
        todayExerciseCount: 5,
      }),
    );
    const types = obs.map(o => `${o.type}:${(o as any).subtype ?? ''}`);
    expect(types).toEqual(
      expect.arrayContaining([
        'lift_progression:up',
        'lift_progression:stall',
        'consistency:',
        'block_position:',
        'effort_zone:',
        'briefing_fallback:',
      ]),
    );
    // Training day → no rest_day observation.
    expect(obs.find(o => o.type === 'rest_day')).toBeUndefined();
  });

  it('on a REST day emits rest_day and NOT a briefing', () => {
    // Rest day = no workoutType / 0 exercises (the dashboard passes these
    // straight from a null todayPlan).
    for (const wt of [null, 'Rest'] as const) {
      const obs = deriveObservations(baseInput({ todayWorkoutType: wt, todayExerciseCount: 0 }));
      expect(obs.find(o => o.type === 'rest_day')).toBeDefined();
      expect(obs.find(o => o.type === 'briefing_fallback')).toBeUndefined();
    }
  });
});

describe('selectTopObservations', () => {
  function obsFixture(): Observation[] {
    return [
      {
        type: 'lift_progression',
        subtype: 'up',
        id: 'lift_progression:Bench',
        factSig: 'up-85',
        salience: 0.9,
        eventDate: '2026-06-08',
        lift: 'Bench',
        from: 80,
        to: 85,
        span: 3,
      },
      {
        type: 'lift_progression',
        subtype: 'stall',
        id: 'lift_progression:Squat',
        factSig: 'stall-100-3',
        salience: 0.8,
        eventDate: '2026-06-05',
        lift: 'Squat',
        weight: 100,
        span: 3,
      },
      {
        type: 'consistency',
        id: 'consistency:days14',
        factSig: 'consist-12of14',
        salience: 0.7,
        eventDate: TODAY,
        metric: 'days14',
        count: 12,
      },
      {
        type: 'briefing_fallback',
        id: 'briefing_fallback',
        factSig: `brief-${TODAY}`,
        salience: 0.1,
        eventDate: TODAY,
        workoutType: 'Push',
        exerciseCount: 5,
      },
    ];
  }

  it('drops factSigs already in recent memory (the dedup guard)', () => {
    const picked = selectTopObservations(obsFixture(), {
      recentFactSigs: new Set(['up-85']),
    });
    expect(picked.find(o => o.factSig === 'up-85')).toBeUndefined();
    // Stall is now the headline; salience 0.8 → also qualifies for a 2nd slot.
    expect(picked[0].factSig).toBe('stall-100-3');
  });

  it('admits a fact whose factSig advanced past the recent set', () => {
    // up-85 was spoken yesterday; today's up-87.5 must speak.
    const today = obsFixture().map(o =>
      o.factSig === 'up-85' ? { ...o, factSig: 'up-87.5', to: 87.5 } as any : o,
    );
    const picked = selectTopObservations(today, {
      recentFactSigs: new Set(['up-85']),
    });
    expect(picked[0].factSig).toBe('up-87.5');
  });

  it('honors the 0.3 salience floor', () => {
    const lowOnly: Observation[] = [
      {
        type: 'block_position',
        id: 'block_position:3',
        factSig: 'block-3',
        salience: 0.2, // below floor (artificial — real block_position is 0.95)
        eventDate: TODAY,
        blockWeek: 3,
      },
    ];
    expect(
      selectTopObservations(lowOnly, { recentFactSigs: new Set() }),
    ).toEqual([]);
  });

  it('returns briefing_fallback only when the headline set is empty', () => {
    const empty = selectTopObservations(
      [obsFixture()[3]],
      { recentFactSigs: new Set() },
    );
    expect(empty).toHaveLength(1);
    expect(empty[0].type).toBe('briefing_fallback');
  });

  it('NOT emits briefing_fallback when its factSig is in recent memory', () => {
    const empty = selectTopObservations(
      [obsFixture()[3]],
      { recentFactSigs: new Set([`brief-${TODAY}`]) },
    );
    expect(empty).toEqual([]);
  });

  // ── rest-day baseline ──────────────────────────────────────────────────
  const restDayObs = (): Observation => ({
    type: 'rest_day',
    id: 'rest_day',
    factSig: `rest-${TODAY}`,
    salience: 0.1,
    eventDate: TODAY,
  });

  it('surfaces rest_day as the rest-day baseline when nothing real wins', () => {
    const picked = selectTopObservations([restDayObs()], { recentFactSigs: new Set() });
    expect(picked).toHaveLength(1);
    expect(picked[0].type).toBe('rest_day');
  });

  it('a PR on a rest day still outranks the rest_day baseline (real signal leads)', () => {
    const pr: Observation = {
      type: 'session_pr',
      id: 'session_pr:Bench',
      factSig: 'pr-90',
      salience: 0.97,
      eventDate: TODAY,
      lift: 'Bench',
      newKg: 90,
      prevKg: 87.5,
    };
    const picked = selectTopObservations([restDayObs(), pr], { recentFactSigs: new Set() });
    expect(picked[0].type).toBe('session_pr');
    // The baseline is suppressed entirely when a real signal took the slot.
    expect(picked.find(o => o.type === 'rest_day')).toBeUndefined();
  });

  it('does NOT re-emit rest_day when its (per-day) factSig is already in recent memory', () => {
    const picked = selectTopObservations(
      [restDayObs()],
      { recentFactSigs: new Set([`rest-${TODAY}`]) },
    );
    expect(picked).toEqual([]);
  });

  it('grants a 2nd slot only at salience >= 0.8', () => {
    const obs: Observation[] = [
      {
        type: 'lift_progression',
        subtype: 'up',
        id: 'A',
        factSig: 'up-100',
        salience: 0.9,
        eventDate: TODAY,
        lift: 'A',
        from: 90,
        to: 100,
        span: 2,
      },
      {
        type: 'consistency',
        id: 'consistency:days14',
        factSig: 'consist-12of14',
        salience: 0.7, // < 0.8 → does NOT earn a slot
        eventDate: TODAY,
        metric: 'days14',
        count: 12,
      },
    ];
    const picked = selectTopObservations(obs, { recentFactSigs: new Set() });
    expect(picked.map(o => o.factSig)).toEqual(['up-100']);
  });

  it('admits a 2nd slot when its salience >= 0.8', () => {
    const picked = selectTopObservations(obsFixture(), {
      recentFactSigs: new Set(),
    });
    expect(picked.map(o => o.factSig)).toEqual(['up-85', 'stall-100-3']);
  });

  it('tie-breaks by eventDate desc, then id asc', () => {
    const same: Observation[] = [
      {
        type: 'lift_progression',
        subtype: 'up',
        id: 'lift_progression:Z',
        factSig: 'up-Z',
        salience: 0.9,
        eventDate: '2026-06-08',
        lift: 'Z',
        from: 80,
        to: 85,
        span: 2,
      },
      {
        type: 'lift_progression',
        subtype: 'up',
        id: 'lift_progression:A',
        factSig: 'up-A',
        salience: 0.9,
        eventDate: '2026-06-09', // more recent — wins
        lift: 'A',
        from: 80,
        to: 85,
        span: 2,
      },
    ];
    const picked = selectTopObservations(same, { recentFactSigs: new Set() });
    expect(picked[0].factSig).toBe('up-A');
  });
});

// ── Composite (synthesis) builders ─────────────────────────────────────

describe('buildPushingHard', () => {
  const benchUp: LiftFact = { name: 'Bench', id: 'lift_progression:Bench', to: 85 };

  it('fires on progression + repeated low energy (>=2)', () => {
    const obs = buildPushingHard([benchUp], 2, 0, TODAY);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('pushing_hard');
    expect(obs!.fatigue).toBe('low_energy');
    expect(obs!.lift).toBe('Bench');
    expect(obs!.salience).toBe(0.92);
    expect(obs!.factSig).toBe('pushing-85-low_energy');
    expect(obs!.subsumes).toContain('lift_progression:Bench');
  });

  it('fires on progression + repeated RIR misses (>=2), and marks "both"', () => {
    expect(buildPushingHard([benchUp], 0, 2, TODAY)!.fatigue).toBe('rir_misses');
    expect(buildPushingHard([benchUp], 3, 4, TODAY)!.fatigue).toBe('both');
  });

  it('does NOT fire without repetition (a single low day / single miss)', () => {
    expect(buildPushingHard([benchUp], 1, 1, TODAY)).toBeNull();
    expect(buildPushingHard([benchUp], 0, 0, TODAY)).toBeNull();
  });

  it('does NOT fire without progression', () => {
    expect(buildPushingHard([], 3, 3, TODAY)).toBeNull();
  });

  it('headlines the strongest mover and subsumes EVERY up fact', () => {
    const obs = buildPushingHard(
      [benchUp, { name: 'Squat', id: 'lift_progression:Squat', to: 140 }],
      2, 0, TODAY,
    );
    expect(obs!.lift).toBe('Squat'); // highest `to`
    expect([...obs!.subsumes].sort()).toEqual(['lift_progression:Bench', 'lift_progression:Squat']);
  });
});

describe('buildGrinding', () => {
  it('fires on a stall + repeated low energy, subsuming the stall fact', () => {
    const obs = buildGrinding(
      [{ name: 'Squat', id: 'lift_progression:Squat', kind: 'stall' }],
      2, TODAY,
    );
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('grinding');
    expect(obs!.strain).toBe('stall');
    expect(obs!.lift).toBe('Squat');
    expect(obs!.salience).toBe(0.88);
    expect(obs!.subsumes).toEqual(['lift_progression:Squat']);
  });

  it('fires on a decline + repeated low energy (a decline has no single fact to subsume)', () => {
    const obs = buildGrinding(
      [{ name: 'Deadlift', id: null, kind: 'decline' }],
      3, TODAY,
    );
    expect(obs!.strain).toBe('decline');
    expect(obs!.subsumes).toEqual([]);
  });

  it('does NOT fire without repeated low energy (<2), or without strain', () => {
    expect(buildGrinding([{ name: 'Squat', id: 'x', kind: 'stall' }], 1, TODAY)).toBeNull();
    expect(buildGrinding([], 3, TODAY)).toBeNull();
  });
});

describe('buildBackOnTrack', () => {
  const benchUp: LiftFact = { name: 'Bench', id: 'lift_progression:Bench', to: 70 };

  it('fires on a comeback followed by progression, subsuming both', () => {
    const obs = buildBackOnTrack(true, ['comeback'], [benchUp], TODAY);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('back_on_track');
    expect(obs!.lift).toBe('Bench');
    expect(obs!.salience).toBe(0.9);
    expect([...obs!.subsumes].sort()).toEqual(['comeback', 'lift_progression:Bench']);
  });

  it('does NOT fire without a comeback, or without progression', () => {
    expect(buildBackOnTrack(false, [], [benchUp], TODAY)).toBeNull();
    expect(buildBackOnTrack(true, ['comeback'], [], TODAY)).toBeNull();
  });
});

describe('isCompositeObservation', () => {
  it('is true only for the synthesis observations', () => {
    expect(isCompositeObservation(buildPushingHard([{ name: 'B', id: 'b', to: 80 }], 2, 0, TODAY)!)).toBe(true);
    const up = buildLiftProgression('B', [{ topKg: 80, date: '2026-06-01' }, { topKg: 85, date: '2026-06-05' }], TODAY)!;
    expect(isCompositeObservation(up)).toBe(false);
  });
});

// ── Selector prefers the synthesis over its component single-facts ─────

describe('selectTopObservations — composite preference', () => {
  const benchUp: CoachObservation = {
    type: 'lift_progression', subtype: 'up', id: 'lift_progression:Bench',
    factSig: 'up-85', salience: 0.9, eventDate: TODAY, lift: 'Bench', from: 80, to: 85, span: 3,
  };
  const pushingHard: CoachObservation = {
    type: 'pushing_hard', id: 'pushing_hard', factSig: 'pushing-85-low_energy',
    salience: 0.92, eventDate: TODAY, lift: 'Bench', fatigue: 'low_energy',
    subsumes: ['lift_progression:Bench'],
  };

  it('surfaces the composite and DROPS the single fact it subsumes', () => {
    const picked = selectTopObservations([benchUp, pushingHard], { recentFactSigs: new Set() });
    expect(picked.map(o => o.type)).toEqual(['pushing_hard']);
    expect(picked.find(o => o.factSig === 'up-85')).toBeUndefined();
  });

  it('a 2nd slot may still go to a NON-subsumed strong fact (complementary, not the part)', () => {
    const block: CoachObservation = {
      type: 'block_position', id: 'block_position:3', factSig: 'block-3',
      salience: 0.95, eventDate: TODAY, blockWeek: 3,
    };
    const picked = selectTopObservations([benchUp, pushingHard, block], { recentFactSigs: new Set() });
    expect(picked.map(o => o.type)).toEqual(['block_position', 'pushing_hard']);
    expect(picked.find(o => o.factSig === 'up-85')).toBeUndefined();
  });

  it('a memory-guarded composite does NOT suppress its parts (memory guard stays in charge)', () => {
    const picked = selectTopObservations(
      [benchUp, pushingHard],
      { recentFactSigs: new Set(['pushing-85-low_energy']) },
    );
    // Composite already said → it's dropped, and the single fact competes normally.
    expect(picked.map(o => o.factSig)).toEqual(['up-85']);
  });

  it('without a composite, the single facts render as before', () => {
    const picked = selectTopObservations([benchUp], { recentFactSigs: new Set() });
    expect(picked.map(o => o.type)).toEqual(['lift_progression']);
  });
});

// ── deriveObservations wires the synthesis end-to-end ──────────────────

describe('deriveObservations — synthesis', () => {
  const climbingBench = {
    Bench: [
      { topKg: 80, date: '2026-06-02' },
      { topKg: 82.5, date: '2026-06-06' },
      { topKg: 85, date: '2026-06-09' },
    ],
  };

  it('emits pushing_hard when progression co-occurs with repeated low energy', () => {
    const obs = deriveObservations(baseInput({
      liftSessions: climbingBench,
      lowEnergySessions: 2,
    }));
    const ph = obs.find(o => o.type === 'pushing_hard');
    expect(ph).toBeDefined();
    // The single up fact is still present in deriveObservations — the SELECTOR
    // is what drops it.
    expect(obs.find(o => o.type === 'lift_progression')).toBeDefined();
    const picked = selectTopObservations(obs, { recentFactSigs: new Set() });
    expect(picked[0].type).toBe('pushing_hard');
    expect(picked.find(o => o.type === 'lift_progression')).toBeUndefined();
  });

  it('emits NO composite when progression occurs WITHOUT fatigue (single fact survives)', () => {
    const obs = deriveObservations(baseInput({
      liftSessions: climbingBench,
      lowEnergySessions: 0,
      rirMissSets: 0,
    }));
    expect(obs.find(o => isCompositeObservation(o))).toBeUndefined();
    const picked = selectTopObservations(obs, { recentFactSigs: new Set() });
    expect(picked[0].type).toBe('lift_progression');
  });

  it('emits grinding when a stall co-occurs with repeated low energy', () => {
    const obs = deriveObservations(baseInput({
      liftSessions: {
        Squat: [
          { topKg: 100, date: '2026-06-02' },
          { topKg: 100, date: '2026-06-06' },
          { topKg: 100, date: '2026-06-09' },
        ],
      },
      lowEnergySessions: 3,
    }));
    expect(obs.find(o => o.type === 'grinding')).toBeDefined();
  });
});

// ── Cold-start sequencing (the headline behavior of this PR) ───────────
//
// Day 1: brand-new user — calibration (0.6) outranks plan_rationale (0.55).
// Day 2: calibration spoken, in recentFactSigs — plan_rationale surfaces.
// Day 3+: both spoken — selector falls through to briefingFallback or [].
// Past sessions exist: a real observation (≥0.7) outranks BOTH cold-starts
// AND the guards have already disabled them in deriveObservations.

describe('cold-start sequencing — calibration → plan_rationale → real obs', () => {
  // Brand-new user, ramping up. Push day, 5 lifts so the fallback can fire.
  const newUserInput = (extra: Partial<ObservationsInput> = {}): ObservationsInput =>
    baseInput({
      split: 'ppl',
      trainingDays: 3,
      firstSessionDaysAgo: null,
      totalCompleted: 0,
      todayWorkoutType: 'Push',
      todayExerciseCount: 5,
      ...extra,
    });

  it('day 1 (nothing spoken yet): calibration headlines, plan_rationale and fallback exist but lose', () => {
    const obs = deriveObservations(newUserInput());
    const types = obs.map(o => o.type).sort();
    expect(types).toEqual(['briefing_fallback', 'calibration', 'plan_rationale']);

    const picked = selectTopObservations(obs, { recentFactSigs: new Set() });
    expect(picked).toHaveLength(1); // 0.6 doesn't earn slot 2
    expect(picked[0].type).toBe('calibration');
    expect(picked[0].factSig).toBe('calibration');
  });

  it('day 2 (calibration in recent): plan_rationale takes the headline', () => {
    const obs = deriveObservations(newUserInput({ firstSessionDaysAgo: 1, totalCompleted: 1 }));
    const picked = selectTopObservations(obs, {
      recentFactSigs: new Set(['calibration']),
    });
    expect(picked).toHaveLength(1);
    expect(picked[0].type).toBe('plan_rationale');
    expect(picked[0].factSig).toBe('rationale-ppl');
  });

  it('day 3 (both cold-starts in recent): selector emits ONLY briefing_fallback', () => {
    const obs = deriveObservations(newUserInput({ firstSessionDaysAgo: 2, totalCompleted: 2 }));
    const picked = selectTopObservations(obs, {
      recentFactSigs: new Set(['calibration', 'rationale-ppl']),
    });
    expect(picked).toHaveLength(1);
    expect(picked[0].type).toBe('briefing_fallback');
  });

  it('once a 0.9 observation exists, both cold-starts are outranked even if still eligible', () => {
    // User is still inside both windows (< 6 sessions, < 14 days) but has
    // a Bench up-85 today. The real observation takes the headline; the
    // cold-starts don't appear in `picked`.
    const obs = deriveObservations(
      newUserInput({
        firstSessionDaysAgo: 7,
        totalCompleted: 5,
        liftSessions: {
          Bench: [
            { topKg: 80, date: '2026-06-03' },
            { topKg: 82.5, date: '2026-06-06' },
            { topKg: 85, date: '2026-06-08' },
          ],
        },
      }),
    );
    const picked = selectTopObservations(obs, { recentFactSigs: new Set() });
    // Headline is the 0.9 lift_progression up; cold-starts and fallback
    // never reach the user.
    expect(picked[0].type).toBe('lift_progression');
    expect(picked.find(p => p.type === 'calibration')).toBeUndefined();
    expect(picked.find(p => p.type === 'plan_rationale')).toBeUndefined();
  });

  it('past the guards (totalCompleted >= 8) the cold-starts stop being emitted entirely', () => {
    const obs = deriveObservations(newUserInput({ firstSessionDaysAgo: 30, totalCompleted: 12 }));
    expect(obs.find(o => o.type === 'calibration')).toBeUndefined();
    expect(obs.find(o => o.type === 'plan_rationale')).toBeUndefined();
  });
});
