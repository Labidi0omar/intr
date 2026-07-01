import { abandonModalCopy, planAbandon, type AbandonAction } from './workoutAbandon';

describe('planAbandon', () => {
  it('always discards the in-memory weight and RIR logs', () => {
    const plan = planAbandon({ hasLoggedSets: true });
    expect(plan.some(a => a.kind === 'clearWeightLog')).toBe(true);
    expect(plan.some(a => a.kind === 'clearRirLog')).toBe(true);
  });

  it('navigates home after the clears (navigation is the last step)', () => {
    const plan = planAbandon({ hasLoggedSets: true });
    expect(plan[plan.length - 1].kind).toBe('navigateHome');
  });

  it('NEVER includes a completion-class action — abandon is not finish', () => {
    // The two sample inputs cover both "no sets logged" and "some sets
    // logged" — the regression we are preventing is a future edit
    // routing the "had sets" branch back into a finish/persist call.
    for (const hasLoggedSets of [true, false]) {
      const plan = planAbandon({ hasLoggedSets });
      for (const action of plan) {
        // Whitelist of allowed kinds. Adding 'persistSession',
        // 'markCompleted', 'finishWorkout', etc. to AbandonAction would
        // break the type and force the callsite to handle them
        // explicitly. This loop catches the runtime case where an
        // already-allowed kind gets repurposed to do persistence.
        const allowed: AbandonAction['kind'][] = [
          'clearWeightLog',
          'clearRirLog',
          'navigateHome',
        ];
        expect(allowed).toContain(action.kind);
      }
    }
  });

  it('produces the same plan whether or not sets were logged', () => {
    // The old modal branched its copy on "has logged sets" because the
    // handler branched its behavior. The handler no longer branches —
    // it always discards — so neither should the plan.
    const withSets = planAbandon({ hasLoggedSets: true });
    const withoutSets = planAbandon({ hasLoggedSets: false });
    expect(withSets).toEqual(withoutSets);
  });
});

describe('abandonModalCopy', () => {
  it('says progress will NOT be saved — no "saved" promise', () => {
    const copy = abandonModalCopy({ hasLoggedSets: true });
    expect(copy.body.toLowerCase()).toMatch(/won't be saved|will not be saved/);
    // The old "what you've logged will be saved" line was a lie because
    // abandon now truly discards. Belt-and-braces: assert it isn't here.
    expect(copy.body.toLowerCase()).not.toMatch(/will be saved/);
    expect(copy.body.toLowerCase()).not.toMatch(/finish later/);
  });

  it('uses a single body line regardless of logged-set state', () => {
    const withSets = abandonModalCopy({ hasLoggedSets: true });
    const withoutSets = abandonModalCopy({ hasLoggedSets: false });
    expect(withSets).toEqual(withoutSets);
  });

  it('confirm button is destructive-named, cancel is reassuring', () => {
    const copy = abandonModalCopy({ hasLoggedSets: false });
    expect(copy.confirmLabel.toLowerCase()).toContain('abandon');
    expect(copy.cancelLabel.toLowerCase()).toMatch(/keep|stay|cancel/);
  });
});
