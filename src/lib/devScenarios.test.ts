import {
  SCENARIO_IDS,
  addDaysIso,
  buildScenario,
  dayOfWeek,
  getScenario,
  listScenarios,
  todayIsoLocal,
  validateScenarios,
} from './devScenarios';

const FIXED_TODAY = '2026-06-22'; // a Monday — deterministic across CI machines

describe('todayIsoLocal + addDaysIso', () => {
  it('formats local YYYY-MM-DD with zero-padding', () => {
    expect(todayIsoLocal(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('shifts dates symmetrically across boundaries', () => {
    expect(addDaysIso('2026-06-22', -7)).toBe('2026-06-15');
    expect(addDaysIso('2026-06-22', 7)).toBe('2026-06-29');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('dayOfWeek matches JS Date.getDay()', () => {
    // 2026-06-22 is a Monday (= 1)
    expect(dayOfWeek('2026-06-22')).toBe(1);
  });
});

describe('scenario catalog', () => {
  it('lists all 9 scenarios in stable order', () => {
    const ids = listScenarios().map(s => s.id);
    expect(ids).toEqual([...SCENARIO_IDS]);
    expect(ids).toHaveLength(9);
  });

  it('getScenario returns null for unknown ids', () => {
    expect(getScenario('does_not_exist')).toBeNull();
  });

  it('every scenario carries a non-empty label and description', () => {
    for (const s of listScenarios()) {
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('buildScenario', () => {
  it('is deterministic for the same (id, nowIso)', () => {
    for (const id of SCENARIO_IDS) {
      const a = buildScenario(id, { nowIso: FIXED_TODAY });
      const b = buildScenario(id, { nowIso: FIXED_TODAY });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('resolves session dates as YYYY-MM-DD strictly on or before today', () => {
    for (const id of SCENARIO_IDS) {
      const r = buildScenario(id, { nowIso: FIXED_TODAY });
      for (const s of r.sessions) {
        expect(s.plannedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(s.plannedDate <= FIXED_TODAY).toBe(true);
      }
    }
  });

  it('fresh_cold_start has no sessions and null bodyweight', () => {
    const r = buildScenario('fresh_cold_start', { nowIso: FIXED_TODAY });
    expect(r.sessions).toEqual([]);
    expect(r.profile.bodyweight_kg).toBeNull();
    expect(r.profile.sex).toBeNull();
  });

  it('comeback_after_gap: most recent session is at least 4 days ago', () => {
    const r = buildScenario('comeback_after_gap', { nowIso: FIXED_TODAY });
    const maxDate = r.sessions.reduce((m, s) => (s.plannedDate > m ? s.plannedDate : m), '');
    const gapDays = (new Date(FIXED_TODAY).getTime() - new Date(maxDate).getTime()) / 86400000;
    expect(gapDays).toBeGreaterThanOrEqual(4);
  });

  it('rest_day_today: training_weekdays excludes today\'s day-of-week', () => {
    const r = buildScenario('rest_day_today', { nowIso: FIXED_TODAY });
    expect(r.profile.training_weekdays).toBeTruthy();
    expect(r.profile.training_weekdays).not.toContain(dayOfWeek(FIXED_TODAY));
    expect(r.profile.training_weekdays!.length).toBe(r.profile.training_days);
  });

  it('training_day_stale_pin: training_weekdays INCLUDES today + has a heroPin postSeed', () => {
    const r = buildScenario('training_day_stale_pin', { nowIso: FIXED_TODAY });
    expect(r.profile.training_weekdays).toContain(dayOfWeek(FIXED_TODAY));
    expect(r.postSeed?.heroPin).toBe('rest-today');
  });

  it('deload_week: anchor week_start is a Monday roughly 3 weeks back', () => {
    const r = buildScenario('deload_week', { nowIso: FIXED_TODAY });
    expect(r.blockAnchorWeekStart).toBeDefined();
    // Anchor must be a Monday (dow === 1) for the block math to align.
    expect(dayOfWeek(r.blockAnchorWeekStart!)).toBe(1);
    // 21 days back from 2026-06-22 (Mon) is 2026-06-01 (also Mon) → anchor === that.
    expect(r.blockAnchorWeekStart).toBe('2026-06-01');
  });

  it('stalling_intermediate: RIR strictly non-increasing across bench sessions', () => {
    const r = buildScenario('stalling_intermediate', { nowIso: FIXED_TODAY });
    const benchRirs = r.sessions
      .sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : 1))
      .map(s => s.logs.find(l => l.exercise_name === 'Barbell Bench Press')?.reps_in_reserve)
      .filter((v): v is number => v != null);
    expect(benchRirs.length).toBeGreaterThan(1);
    for (let i = 1; i < benchRirs.length; i++) {
      expect(benchRirs[i]).toBeLessThanOrEqual(benchRirs[i - 1]);
    }
    // Final session must hit failure to trigger the backoff branch.
    expect(benchRirs[benchRirs.length - 1]).toBe(0);
  });

  it('recovering_well: bench weight strictly increasing', () => {
    const r = buildScenario('recovering_well', { nowIso: FIXED_TODAY });
    const benchKgs = r.sessions
      .sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : 1))
      .map(s => s.logs.find(l => l.exercise_name === 'Barbell Bench Press')?.weight_kg)
      .filter((v): v is number => v != null);
    expect(benchKgs.length).toBeGreaterThan(1);
    for (let i = 1; i < benchKgs.length; i++) {
      expect(benchKgs[i]).toBeGreaterThan(benchKgs[i - 1]);
    }
  });

  it('pr_just_hit: the most recent bench session has the highest weight', () => {
    const r = buildScenario('pr_just_hit', { nowIso: FIXED_TODAY });
    const sorted = r.sessions.sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : 1));
    const benchKgs = sorted
      .map(s => s.logs.find(l => l.exercise_name === 'Barbell Bench Press')?.weight_kg)
      .filter((v): v is number => v != null);
    expect(benchKgs.length).toBeGreaterThan(1);
    const last = benchKgs[benchKgs.length - 1]!;
    const priorMax = Math.max(...benchKgs.slice(0, -1));
    expect(last).toBeGreaterThan(priorMax);
  });

  it('overreaching: last two sessions are low energy', () => {
    const r = buildScenario('overreaching', { nowIso: FIXED_TODAY });
    const sorted = r.sessions.sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : 1));
    const lastTwo = sorted.slice(-2);
    expect(lastTwo.length).toBe(2);
    for (const s of lastTwo) {
      expect(s.energyScore).toBeLessThanOrEqual(2);
      expect(s.energyLevel).toBe('low');
    }
  });
});

describe('validateScenarios', () => {
  it('every scenario passes shape validation', () => {
    const issues = validateScenarios(new Date(2026, 5, 22)); // 2026-06-22
    expect(issues).toEqual([]);
  });
});
