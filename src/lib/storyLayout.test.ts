import {
  clampCardToCanvas,
  clampNum,
  computeStoryCardLayout,
  mapEditorToCanvas,
} from './storyLayout';

describe('computeStoryCardLayout', () => {
  it('centers the card horizontally on the canvas', () => {
    const l = computeStoryCardLayout({ cardAspect: 1.2 });
    expect(l.cardX).toBe(Math.round((1080 - l.cardW) / 2));
    // widthFraction 0.84 → 907 wide, centered.
    expect(l.cardW).toBe(Math.round(1080 * 0.84));
    expect(l.cardX).toBe(Math.round((1080 - l.cardW) / 2));
  });

  it('derives cardH from the aspect', () => {
    const l = computeStoryCardLayout({ cardAspect: 0.5 });
    expect(l.cardH).toBe(Math.round(l.cardW * 0.5));
  });

  it('keeps the card inside the top/bottom safe zones', () => {
    const l = computeStoryCardLayout({ cardAspect: 1.0 });
    expect(l.cardTop).toBeGreaterThanOrEqual(250); // topSafe
    expect(l.cardTop + l.cardH).toBeLessThanOrEqual(1920 - 420); // above bottomSafe
  });

  it('clamps a low verticalCenterFraction up to the top safe zone', () => {
    const l = computeStoryCardLayout({ cardAspect: 1.2, verticalCenterFraction: 0.05 });
    expect(l.cardTop).toBe(250);
  });

  it('clamps a high verticalCenterFraction down so the card stays above the bottom safe zone', () => {
    const l = computeStoryCardLayout({ cardAspect: 1.2, verticalCenterFraction: 0.98 });
    expect(l.cardTop).toBe(1920 - 420 - l.cardH);
    expect(l.cardTop + l.cardH).toBeLessThanOrEqual(1920 - 420);
  });

  it('shrinks an oversized (very tall) card to fit the safe band, keeping aspect', () => {
    // aspect 3 → naive cardH = 907*3 ≈ 2721, far taller than the safe band.
    const safeBand = 1920 - 250 - 420; // 1250
    const l = computeStoryCardLayout({ cardAspect: 3 });
    expect(l.cardH).toBeLessThanOrEqual(safeBand);
    expect(l.cardH).toBe(safeBand);
    // Width was recomputed from the clamped height at the same aspect.
    expect(l.cardW).toBe(Math.round(l.cardH / 3));
    // Still fits within the safe zones after the shrink.
    expect(l.cardTop).toBeGreaterThanOrEqual(250);
    expect(l.cardTop + l.cardH).toBeLessThanOrEqual(1920 - 420);
  });

  it('respects a custom canvas size and width fraction', () => {
    const l = computeStoryCardLayout({ canvasW: 720, canvasH: 1280, cardAspect: 1, widthFraction: 0.5, topSafe: 100, bottomSafe: 100 });
    expect(l.cardW).toBe(360);
    expect(l.cardX).toBe(180);
  });
});

describe('mapEditorToCanvas', () => {
  it('scales editor coordinates up to the 1080-wide output', () => {
    // editor 360 wide → 3× to canvas 1080.
    const m = mapEditorToCanvas({ editorW: 360, cardEditorX: 30, cardEditorY: 100, cardEditorW: 300 });
    expect(m.cardX).toBe(90);
    expect(m.cardY).toBe(300);
    expect(m.cardW).toBe(900);
  });

  it('maps a card centered in the editor to a card centered on the canvas', () => {
    const editorW = 360;
    const editorH = 640; // 9:16
    const cardW = 200;
    const cardH = 240;
    // Centered in editor.
    const cardEditorX = (editorW - cardW) / 2; // 80
    const cardEditorY = (editorH - cardH) / 2; // 200
    const m = mapEditorToCanvas({ editorW, cardEditorX, cardEditorY, cardEditorW: cardW });
    // Centered on canvas too: x + w/2 === canvasW/2.
    expect(m.cardX + m.cardW / 2).toBe(1080 / 2);
    // y center maps to 200/640 of canvas height (1920) → same fraction.
    expect(m.cardY + (cardH * (1080 / editorW)) / 2).toBeCloseTo((editorH / 2) * (1080 / editorW), 0);
  });

  it('keeps all mapped coordinates within the canvas for an in-bounds editor card', () => {
    const editorW = 412;
    const editorH = Math.round(editorW * (1920 / 1080));
    const cardW = 280;
    const cardH = Math.round(cardW * 1.2);
    // A few in-bounds placements.
    for (const [x, y] of [[0, 0], [editorW - cardW, 0], [0, editorH - cardH], [editorW - cardW, editorH - cardH], [50, 300]]) {
      const m = mapEditorToCanvas({ editorW, cardEditorX: x, cardEditorY: y, cardEditorW: cardW });
      expect(m.cardX).toBeGreaterThanOrEqual(0);
      expect(m.cardY).toBeGreaterThanOrEqual(0);
      expect(m.cardX + m.cardW).toBeLessThanOrEqual(1080 + 1); // rounding slack
      const mappedH = Math.round(cardH * (1080 / editorW));
      expect(m.cardY + mappedH).toBeLessThanOrEqual(1920 + 2); // rounding slack
    }
  });
});

describe('clampCardToCanvas', () => {
  it('pulls a negative top-left back to the origin', () => {
    expect(clampCardToCanvas({ x: -50, y: -30, w: 100, h: 120, editorW: 360, editorH: 640 }))
      .toEqual({ x: 0, y: 0 });
  });

  it('stops the far edge from leaving the canvas', () => {
    const r = clampCardToCanvas({ x: 1000, y: 1000, w: 100, h: 120, editorW: 360, editorH: 640 });
    expect(r.x).toBe(360 - 100);
    expect(r.y).toBe(640 - 120);
  });

  it('leaves an in-bounds card untouched', () => {
    expect(clampCardToCanvas({ x: 40, y: 80, w: 100, h: 120, editorW: 360, editorH: 640 }))
      .toEqual({ x: 40, y: 80 });
  });

  it('clamps a card larger than the canvas to the origin (never negative)', () => {
    expect(clampCardToCanvas({ x: 10, y: 10, w: 500, h: 900, editorW: 360, editorH: 640 }))
      .toEqual({ x: 0, y: 0 });
  });
});

describe('clampNum', () => {
  it('clamps into range and tolerates hi < lo', () => {
    expect(clampNum(5, 0, 10)).toBe(5);
    expect(clampNum(-1, 0, 10)).toBe(0);
    expect(clampNum(99, 0, 10)).toBe(10);
    expect(clampNum(5, 10, 0)).toBe(10); // hi < lo → prefer lo
  });
});
