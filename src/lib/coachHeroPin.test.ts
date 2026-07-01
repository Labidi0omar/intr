// Tests for the per-day hero pin. AsyncStorage round-trips are deferred
// to the host (home.tsx); here we pin (and pin only) the pure decision
// shape so the stability contract is locked.

import { chooseHeroFactSig } from './coachHeroPin';

describe('chooseHeroFactSig — stability', () => {
  it('returns the pinned factSig when it is still in the available set', () => {
    const pinned = 'pushing-85-low_energy';
    const picked = ['stall-100-3', 'consist-12of14'];
    const available = new Set(['pushing-85-low_energy', 'stall-100-3']);
    expect(chooseHeroFactSig(picked, available, pinned)).toBe(pinned);
  });

  it('falls back to the first picked factSig when nothing is pinned', () => {
    const picked = ['grinding-Squat-stall', 'block-4'];
    const available = new Set(picked);
    expect(chooseHeroFactSig(picked, available, null)).toBe('grinding-Squat-stall');
  });

  it('falls back to the first picked factSig when the pinned line has been evicted', () => {
    // Pinned line is no longer in the store (message store rolled it out
    // / day rolled / data changed). We need SOMETHING to render — pick
    // the new headline.
    const picked = ['block-4', 'pushing-85-low_energy'];
    const available = new Set(picked); // pinned NOT in this set
    expect(chooseHeroFactSig(picked, available, 'stale-old-fact')).toBe('block-4');
  });

  it('returns null when there is nothing to render (no pin, no picks)', () => {
    expect(chooseHeroFactSig([], new Set(), null)).toBeNull();
  });

  it('returns the same factSig on repeated calls (deterministic stability)', () => {
    const picked = ['pushing-85-low_energy', 'block-4'];
    const available = new Set(picked);
    const a = chooseHeroFactSig(picked, available, 'pushing-85-low_energy');
    const b = chooseHeroFactSig(picked, available, 'pushing-85-low_energy');
    const c = chooseHeroFactSig(picked, available, 'pushing-85-low_energy');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('pushing-85-low_energy');
  });

  it('day-rollover semantics: a fresh day with no pin picks the new headline', () => {
    // Caller passes pinnedFactSig=null because readPinnedHeroFactSig
    // returned null (stored date !== today). The helper then surfaces
    // the new top pick to be re-pinned.
    const picked = ['grinding-Squat-stall'];
    expect(chooseHeroFactSig(picked, new Set(picked), null)).toBe('grinding-Squat-stall');
  });
});

describe('chooseHeroFactSig — todayKind coherence', () => {
  it("todayKind 'unknown' suppresses the hero (returns null) even with a strong pick", () => {
    // Plan not loaded yet — the hero must NEVER assert anything from a
    // transient unknown pass. This closes the "Rest today" flash bug.
    const picked = ['stall-100-3', 'block-4'];
    const available = new Set(picked);
    expect(chooseHeroFactSig(picked, available, null, 'unknown')).toBeNull();
    expect(chooseHeroFactSig(picked, available, 'stall-100-3', 'unknown')).toBeNull();
  });

  it("discards a rest pin on a training day (the regression bug)", () => {
    // A previous focus pass ran while plan was loading (unknown), wrote
    // rest_day to the store, and pinned 'rest-2026-06-21'. Plan then
    // loaded as training. The pinned rest line must NOT resurface.
    const pinned = 'rest-2026-06-21';
    const picked = ['stall-100-3'];
    const available = new Set(['stall-100-3', 'rest-2026-06-21']);
    expect(chooseHeroFactSig(picked, available, pinned, 'training')).toBe('stall-100-3');
  });

  it("discards a non-rest pin on a rest day (the inverse incoherence)", () => {
    const pinned = 'stall-100-3';
    const picked = ['rest-2026-06-21'];
    const available = new Set(['stall-100-3', 'rest-2026-06-21']);
    expect(chooseHeroFactSig(picked, available, pinned, 'rest')).toBe('rest-2026-06-21');
  });

  it("keeps a coherent rest pin on a rest day", () => {
    const pinned = 'rest-2026-06-21';
    const picked = ['rest-2026-06-21'];
    const available = new Set([pinned]);
    expect(chooseHeroFactSig(picked, available, pinned, 'rest')).toBe(pinned);
  });

  it("keeps a coherent training pin on a training day", () => {
    const pinned = 'pushing-85-low_energy';
    const picked = ['pushing-85-low_energy', 'block-4'];
    const available = new Set(picked);
    expect(chooseHeroFactSig(picked, available, pinned, 'training')).toBe(pinned);
  });

  it("without todayKind the v1 stability contract is preserved (back-compat)", () => {
    const pinned = 'rest-2026-06-21';
    const picked = ['stall-100-3'];
    const available = new Set([pinned]);
    // No kind → no coherence guard → pin stays.
    expect(chooseHeroFactSig(picked, available, pinned)).toBe(pinned);
  });
});
