// Pure, native-free geometry for the in-app composite Story share. Kept free
// of any react-native import so the layout math is unit-testable under the
// node/ts-jest setup. Two coordinate spaces:
//
//   • CANVAS  — the final 1080×1920 output we composite + capture.
//   • EDITOR  — the on-screen 9:16 preview the user drags the card around in.
//
// computeStoryCardLayout gives the card's default placement (canvas space).
// mapEditorToCanvas converts the user's on-screen placement to canvas space.
// Both preserve the 9:16 aspect, so a single uniform scale maps between them.

/** Clamp a number into [lo, hi]. Tolerates hi < lo by preferring lo. */
export function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}

export interface StoryCardLayoutInput {
  canvasW?: number;
  canvasH?: number;
  /** Card height / width. Drives cardH and the shrink-to-fit check. */
  cardAspect: number;
  widthFraction?: number;
  verticalCenterFraction?: number;
  topSafe?: number;
  bottomSafe?: number;
}

export interface StoryCardLayout {
  cardW: number;
  cardH: number;
  cardX: number;
  cardTop: number;
}

/**
 * Default placement for the card on the 1080×1920 canvas: a width-fraction of
 * the canvas, horizontally centered, vertically centered around
 * verticalCenterFraction but clamped inside the top/bottom safe zones (the
 * bands Instagram's own UI covers). If the card is taller than the safe band
 * between those zones, it's scaled down (keeping aspect) to fit. This is also
 * the editor's starting position (scaled into editor space by the caller).
 */
export function computeStoryCardLayout(input: StoryCardLayoutInput): StoryCardLayout {
  const canvasW = input.canvasW ?? 1080;
  const canvasH = input.canvasH ?? 1920;
  const widthFraction = input.widthFraction ?? 0.84;
  const verticalCenterFraction = input.verticalCenterFraction ?? 0.60;
  const topSafe = input.topSafe ?? 250;
  const bottomSafe = input.bottomSafe ?? 420;
  const aspect = Number.isFinite(input.cardAspect) && input.cardAspect > 0 ? input.cardAspect : 1;

  let cardW = Math.round(canvasW * widthFraction);
  let cardH = Math.round(cardW * aspect);

  // Shrink-to-fit: never let the card spill into the safe zones.
  const safeBandH = canvasH - topSafe - bottomSafe;
  if (safeBandH > 0 && cardH > safeBandH) {
    cardH = safeBandH;
    cardW = Math.round(cardH / aspect);
  }

  const cardX = Math.round((canvasW - cardW) / 2);
  const rawTop = Math.round(canvasH * verticalCenterFraction - cardH / 2);
  const maxTop = canvasH - bottomSafe - cardH;
  const cardTop = clampNum(rawTop, topSafe, maxTop);

  return { cardW, cardH, cardX, cardTop };
}

export interface MapEditorToCanvasInput {
  /** Width of the on-screen editor preview, in editor px. */
  editorW: number;
  canvasW?: number;
  cardEditorX: number;
  cardEditorY: number;
  cardEditorW: number;
}

export interface MappedCard {
  cardX: number;
  cardY: number;
  cardW: number;
}

/**
 * Convert the user's final on-screen card placement (editor px) to canvas px.
 * Because the editor preview and the canvas share the 9:16 aspect, x and y use
 * the SAME scale (canvasW / editorW).
 */
export function mapEditorToCanvas(input: MapEditorToCanvasInput): MappedCard {
  const canvasW = input.canvasW ?? 1080;
  const scale = input.editorW > 0 ? canvasW / input.editorW : 1;
  return {
    cardX: Math.round(input.cardEditorX * scale),
    cardY: Math.round(input.cardEditorY * scale),
    cardW: Math.round(input.cardEditorW * scale),
  };
}

export interface ClampCardInput {
  x: number;
  y: number;
  /** Card width + height in editor px (height = width * aspect). */
  w: number;
  h: number;
  editorW: number;
  editorH: number;
}

/**
 * Keep the card fully inside the editor canvas [0, editorW] × [0, editorH] —
 * its top-left can't go negative and its far edge can't pass the canvas edge.
 * Used while dragging/pinching so the card can never leave the preview.
 */
export function clampCardToCanvas(input: ClampCardInput): { x: number; y: number } {
  const maxX = Math.max(0, input.editorW - input.w);
  const maxY = Math.max(0, input.editorH - input.h);
  return {
    x: clampNum(input.x, 0, maxX),
    y: clampNum(input.y, 0, maxY),
  };
}
