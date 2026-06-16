import { computeEarlyWins } from './earlyWins';
import type { LiftSessionTop } from './coachObservations';

// Session-top history is OLDEST-FIRST (the order home.tsx sorts it into).
const s = (date: string, topKg: number): LiftSessionTop => ({ date, topKg });

const TODAY = '2026-06-14';

describe('computeEarlyWins', () => {
  it('fresh account (nothing logged) → show:false, never "0"', () => {
    expect(computeEarlyWins({}, { todayIso: TODAY })).toEqual({ liftsImproved: 0, show: false });
  });

  it('a lift trained only once → no win (need two sessions to add weight)', () => {
    const win = computeEarlyWins({ Bench: [s('2026-06-12', 60)] }, { todayIso: TODAY });
    expect(win).toEqual({ liftsImproved: 0, show: false });
  });

  it('counts a real recent increase on a single lift', () => {
    const win = computeEarlyWins(
      { Bench: [s('2026-06-09', 60), s('2026-06-12', 62.5)] },
      { todayIso: TODAY },
    );
    expect(win.liftsImproved).toBe(1);
    expect(win.show).toBe(true);
  });

  it('counts distinct lifts that each added weight', () => {
    const win = computeEarlyWins(
      {
        Bench: [s('2026-06-09', 60), s('2026-06-12', 62.5)],
        Squat: [s('2026-06-08', 100), s('2026-06-13', 105)],
        Row: [s('2026-06-10', 70), s('2026-06-13', 70)], // flat → not a win
      },
      { todayIso: TODAY },
    );
    expect(win.liftsImproved).toBe(2);
    expect(win.show).toBe(true);
  });

  it('a decrease is not a win (honest — never spins a drop as progress)', () => {
    const win = computeEarlyWins(
      { Deadlift: [s('2026-06-09', 140), s('2026-06-12', 135)] },
      { todayIso: TODAY },
    );
    expect(win).toEqual({ liftsImproved: 0, show: false });
  });

  it('a stale improvement (older than the recent window) is excluded', () => {
    // Last increase landed 30 days ago — not "this week".
    const win = computeEarlyWins(
      { Bench: [s('2026-05-10', 60), s('2026-05-15', 62.5)] },
      { todayIso: TODAY },
    );
    expect(win.show).toBe(false);
  });

  it('only the most recent two sessions decide it (latest must beat the prior one)', () => {
    // Climbed then held: last == prev → not a fresh add.
    const win = computeEarlyWins(
      { Bench: [s('2026-06-06', 60), s('2026-06-10', 65), s('2026-06-13', 65)] },
      { todayIso: TODAY },
    );
    expect(win.show).toBe(false);
  });

  it('tolerates malformed input without throwing', () => {
    // @ts-expect-error — exercising the defensive guard
    expect(computeEarlyWins(null, { todayIso: TODAY })).toEqual({ liftsImproved: 0, show: false });
    expect(computeEarlyWins({ Bench: [] }, { todayIso: TODAY })).toEqual({ liftsImproved: 0, show: false });
  });
});
