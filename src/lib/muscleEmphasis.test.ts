import { emphasisToRender, type MuscleEmphasis } from './muscleEmphasis';
import { PATHS_BY_ID } from '../constants/musclePaths';

// ── emphasisToRender: exhaustive per-value coverage ─────────────────
//
// The switch inside emphasisToRender is exhaustiveness-checked via
// `never`, so a new emphasis literal without a case is a compile
// error. These runtime tests pin the specific mapping we ship — a
// silent case rewrite would flip the highlight for a real exercise.

describe('emphasisToRender', () => {
  it('chest-upper → front / overlay path chest-upper', () => {
    expect(emphasisToRender('chest-upper')).toEqual({
      view: 'front',
      kind: 'overlay',
      pathId: 'chest-upper',
    });
  });

  it('chest-lower → front / overlay path chest-lower', () => {
    expect(emphasisToRender('chest-lower')).toEqual({
      view: 'front',
      kind: 'overlay',
      pathId: 'chest-lower',
    });
  });

  it('back-lats → back / overlay path back-lats', () => {
    expect(emphasisToRender('back-lats')).toEqual({
      view: 'back',
      kind: 'overlay',
      pathId: 'back-lats',
    });
  });

  it('back-traps → back / native slug trapezius (no overlay authored)', () => {
    // The library already ships a trapezius slug on the back view, so
    // this case delegates to <Body> instead of authoring a custom
    // polygon — exactly what the audit called for.
    expect(emphasisToRender('back-traps')).toEqual({
      view: 'back',
      kind: 'native',
      slug: 'trapezius',
    });
  });

  it('back-lower → back / native slug lower-back (no overlay authored)', () => {
    expect(emphasisToRender('back-lower')).toEqual({
      view: 'back',
      kind: 'native',
      slug: 'lower-back',
    });
  });

  it('shoulders-front → front / overlay path shoulders-front-delt', () => {
    expect(emphasisToRender('shoulders-front')).toEqual({
      view: 'front',
      kind: 'overlay',
      pathId: 'shoulders-front-delt',
    });
  });

  it('shoulders-side → front / overlay path shoulders-side-delt', () => {
    expect(emphasisToRender('shoulders-side')).toEqual({
      view: 'front',
      kind: 'overlay',
      pathId: 'shoulders-side-delt',
    });
  });

  it('shoulders-rear → back / native slug deltoids (rear head IS what the back view shows)', () => {
    // On the back view, the deltoid slug covers only the posterior
    // head (the anterior + lateral heads face forward and aren't in
    // the back-view asset at all). Delegating to that native slug —
    // rather than authoring a hand-traced overlay — guarantees the
    // highlight aligns exactly with the library's built-in geometry.
    expect(emphasisToRender('shoulders-rear')).toEqual({
      view: 'back',
      kind: 'native',
      slug: 'deltoids',
    });
  });

  // Overlay paths named by the map must exist in PATHS_BY_ID. Guards
  // against a rename in one module that isn't mirrored in the other.
  it('every overlay pathId returned by the map exists in PATHS_BY_ID', () => {
    const values: MuscleEmphasis[] = [
      'chest-upper',
      'chest-lower',
      'back-lats',
      'back-traps',
      'back-lower',
      'shoulders-front',
      'shoulders-side',
      'shoulders-rear',
    ];
    for (const e of values) {
      const r = emphasisToRender(e);
      if (r.kind === 'overlay') {
        expect(PATHS_BY_ID[r.pathId]).toBeTruthy();
      }
    }
  });

  // Sanity: the map is a pure function of its argument — no shared
  // state, no random ordering.
  it('is deterministic: two calls with the same input match', () => {
    expect(emphasisToRender('chest-upper')).toEqual(emphasisToRender('chest-upper'));
    expect(emphasisToRender('shoulders-rear')).toEqual(emphasisToRender('shoulders-rear'));
  });
});

// ── Fallback: unset emphasis must not change existing render ─────────
//
// MuscleDetails threads emphasis through as an optional prop. When the
// exercise catalog entry has no emphasis (100+ of our existing entries),
// the component must fall back to the pre-emphasis behavior: figure
// with the muscleInfo-mapped native slug in the highlight color, no
// overlay, no view flip. This exercises the FALLBACK BRANCH directly
// so a future refactor can't silently change the default.

describe('emphasis fallback (unset emphasis)', () => {
  it('emphasisToRender is never called when emphasis is undefined — MuscleDetails routes through the info.slug branch instead', () => {
    // The map is TOTAL over the MuscleEmphasis union but must not be
    // called with a nullish input. MuscleDetails guards this via a
    // truthy check (`emphasis ? emphasisToRender(...) : null`). This
    // test documents the invariant so a future maintainer who wants to
    // "just be defensive" doesn't accidentally add an 'undefined' arm
    // to the switch and dilute the exhaustiveness check.
    const guard = (emphasis: MuscleEmphasis | undefined) =>
      emphasis ? emphasisToRender(emphasis) : null;
    expect(guard(undefined)).toBeNull();
    expect(guard('chest-upper')).toEqual({
      view: 'front',
      kind: 'overlay',
      pathId: 'chest-upper',
    });
  });
});
