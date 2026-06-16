import { bestBlockProgress, buildCampaignStatus } from './campaignStatus';

const TODAY = '2026-06-10'; // a Wednesday
const WEEK_START = '2026-06-08'; // Monday of the current plan week

describe('buildCampaignStatus', () => {
  it('returns null when blockWeek is unknown', () => {
    expect(
      buildCampaignStatus({
        todayStr: TODAY,
        blockWeek: undefined,
        weekStart: WEEK_START,
        energyScore: 3,
        todayLogs: [],
        exerciseHistory: {},
      }),
    ).toBeNull();
  });

  it('returns null on an out-of-range blockWeek', () => {
    for (const bad of [0, 5, -1]) {
      expect(
        buildCampaignStatus({
          todayStr: TODAY,
          blockWeek: bad,
          weekStart: WEEK_START,
          energyScore: 3,
          todayLogs: [],
          exerciseHistory: {},
        }),
      ).toBeNull();
    }
  });

  it('builds the full campaign block on a mid-block week with progress', () => {
    // Week 3 ⇒ block started 2026-05-25; deload week starts 2026-06-15.
    const msg = buildCampaignStatus({
      todayStr: TODAY,
      blockWeek: 3,
      weekStart: WEEK_START,
      energyScore: 3,
      todayLogs: [{ exercise_name: 'Bench Press', weight_kg: 67.5 }],
      exerciseHistory: {
        'Bench Press': [
          { weight_kg: 65, date: '2026-06-03' },
          { weight_kg: 60, date: '2026-05-27' }, // oldest in-block ⇒ baseline
          { weight_kg: 62.5, date: '2026-05-20' }, // pre-block, ignored
        ],
      },
    });
    expect(msg).toBe(
      [
        'Week 3 of the hypertrophy block.',
        'Bench Press up 7.5 kg since week 1.',
        'Recovery is stable.',
        'Deload in 5 days.',
      ].join('\n'),
    );
  });

  it('skips the progress line on week 1 (week 1 is the baseline)', () => {
    const msg = buildCampaignStatus({
      todayStr: TODAY,
      blockWeek: 1,
      weekStart: WEEK_START,
      energyScore: 4,
      todayLogs: [{ exercise_name: 'Squat', weight_kg: 100 }],
      exerciseHistory: { Squat: [{ weight_kg: 90, date: '2026-06-01' }] },
    });
    expect(msg).toBe(
      ['Week 1 of the hypertrophy block.', 'Recovery is strong.', 'Deload in 19 days.'].join('\n'),
    );
  });

  it('frames week 4 as deload with no progress celebration or countdown', () => {
    const msg = buildCampaignStatus({
      todayStr: TODAY,
      blockWeek: 4,
      weekStart: WEEK_START,
      energyScore: 2,
      todayLogs: [{ exercise_name: 'Bench Press', weight_kg: 70 }],
      exerciseHistory: {
        'Bench Press': [{ weight_kg: 60, date: '2026-05-20' }],
      },
    });
    expect(msg).toBe(
      [
        'Week 4 of the hypertrophy block — deload.',
        'Recovery is running low — sleep is part of the program.',
        'Recover hard — next block starts from here.',
      ].join('\n'),
    );
  });

  it('falls back to a week-granularity countdown without weekStart', () => {
    const msg = buildCampaignStatus({
      todayStr: TODAY,
      blockWeek: 2,
      weekStart: undefined,
      energyScore: 3,
      todayLogs: [],
      exerciseHistory: {},
    });
    expect(msg).toBe(
      ['Week 2 of the hypertrophy block.', 'Recovery is stable.', 'Deload in 2 weeks.'].join('\n'),
    );
  });

  it('drops the progress line when no lift gained inside the block', () => {
    const msg = buildCampaignStatus({
      todayStr: TODAY,
      blockWeek: 2,
      weekStart: WEEK_START,
      energyScore: 3,
      todayLogs: [{ exercise_name: 'Bench Press', weight_kg: 60 }],
      exerciseHistory: {
        'Bench Press': [{ weight_kg: 62.5, date: '2026-06-04' }], // regressed
      },
    });
    expect(msg).toBe(
      ['Week 2 of the hypertrophy block.', 'Recovery is stable.', 'Deload in 12 days.'].join('\n'),
    );
  });

  it('says "Deload in 1 day" (singular) the day before the deload week', () => {
    const msg = buildCampaignStatus({
      todayStr: '2026-06-14', // Sunday before the 06-15 deload Monday
      blockWeek: 3,
      weekStart: WEEK_START,
      energyScore: 3,
      todayLogs: [],
      exerciseHistory: {},
    });
    expect(msg).toContain('Deload in 1 day.');
  });
});

describe('bestBlockProgress', () => {
  const base = { todayStr: TODAY, blockStartStr: '2026-05-25' };

  it('picks the biggest in-block gain across lifts', () => {
    const pick = bestBlockProgress({
      ...base,
      todayLogs: [
        { exercise_name: 'Bench Press', weight_kg: 65 },
        { exercise_name: 'Squat', weight_kg: 110 },
      ],
      exerciseHistory: {
        'Bench Press': [{ weight_kg: 60, date: '2026-05-27' }], // +5
        Squat: [{ weight_kg: 100, date: '2026-05-26' }], // +10 ⇒ wins
      },
    });
    expect(pick).toEqual({ name: 'Squat', delta: 10 });
  });

  it('ignores bodyweight lifts, pre-block history, and today-dated rows', () => {
    const pick = bestBlockProgress({
      ...base,
      todayLogs: [
        { exercise_name: 'Pull-Up', weight_kg: null },
        { exercise_name: 'Bench Press', weight_kg: 70 },
      ],
      exerciseHistory: {
        'Pull-Up': [{ weight_kg: 0, date: '2026-05-26' }],
        'Bench Press': [
          { weight_kg: 70, date: TODAY }, // today's own row — not a prior
          { weight_kg: 50, date: '2026-05-01' }, // pre-block
        ],
      },
    });
    expect(pick).toBeNull();
  });
});
