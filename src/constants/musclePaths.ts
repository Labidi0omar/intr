// Custom SVG path strings for muscle sub-regions the base library
// (react-native-body-highlighter) doesn't natively separate. Used by
// MuscleOverlay via a stacked <Svg> that shares the library's exact
// coordinate system.
//
// ── HOW THESE COORDINATES WERE DERIVED ────────────────────────────────
//
// Each polygon is traced from the library's ACTUAL PATH VERTEX DATA, not
// from a bounding box. The first pass of this file tried the bbox route
// and produced small misplaced rectangles that floated over the figure;
// the current pass copies the library's own Bezier segments for every
// outer edge, then closes each sub-region with a straight cut at the
// muscle-head split line. Result: outer curves hug the library outline
// exactly; the inner split (e.g. y=378 across the chest) is a straight
// anatomical boundary the eye reads as the muscle-head border.
//
// Vertex data was read from:
//   node_modules/react-native-body-highlighter/dist/assets/bodyFront.js
//     chest    (line 6)   — left pec M272.91 422.84;  right pec M416.04 435
//     deltoids (line 122) — left delt M274.06 311.69; right delt M450.39 320.75
//   node_modules/react-native-body-highlighter/dist/assets/bodyBack.js
//     upper-back (line 46) — reference for lat wing coordinates
//
// Front-view slugs use viewBox "0 0 724 1448" — coordinates in x∈[0,724].
// Back-view  slugs use viewBox "724 0 724 1448" — coordinates in x∈[724,1448].
// Front-view midline (between left/right pec) at x≈362. Back-view
// midline (spine) at x≈1086.
//
// Version pin: coordinates are stable at react-native-body-highlighter
// 3.2.0. package.json pins the exact version — a viewBox change upstream
// would silently misalign every path, so a maintainer bumping the pin
// must re-verify these values against the new asset files.

/** Identifier for a custom overlay path. Kept as a union so the compiler
 *  catches typos at every call site. */
export type MusclePathId =
  | 'chest-upper'
  | 'chest-lower'
  | 'back-lats'
  | 'shoulders-front-delt'
  | 'shoulders-side-delt';

// ── Chest ────────────────────────────────────────────────────────────
//
// Built-in chest slug (bodyFront.js:6-17) draws two "shield" shapes,
// one per pec. Traced vertex sequence for each pec (clockwise from
// bottom-inner):
//
//   Left pec:
//     (272.91, 422.84) bottom-inner  →  (260.27, 344.05) top-outer  →
//     (300.24, 318.18) top-arc-left  →  (337.26, 318.93) top-arc-right  →
//     (355.67, 343.97) top-inner     →  (357.34, 392.03) mid-inner  →
//     (355.29, 408.92) lower-inner   →  (297.01, 433.45) bottom-mid  →
//     back to start.
//
//   Right pec (mirror-ish, not exactly symmetric):
//     (416.04, 435) bottom-inner    →  (374.67, 413.52) bottom-mid  →
//     (371.83, 401.34) lower-inner  →  (380.27, 326.55) mid-inner  →
//     (398.63, 317.99) top-arc-left →  (421.95, 317.64) top-arc-right  →
//     (448.57, 325.51) top-outer    →  (471.24, 355.26) upper-side  →
//     (443.03, 430.23) bottom-outer →  back to start.
//
// Split boundary at y=378 (mid-pec vertically). Upper polygon uses the
// TOP curves verbatim from the library then cuts horizontally at y=378;
// lower polygon uses the BOTTOM curves and cuts at the same y.

const CHEST_UPPER: string =
  // Left pec, upper half. Segments 1–4 of the library's left-pec path
  // (outer edge up, top arc across, inner edge down), then L across
  // to close at y=378.
  'M 266 378 ' +
  'L 260.27 344.05 ' +
  'c 5.57 -12.99, 26.54 -24.37, 39.97 -25.87 ' +
  'q 20.36 -2.26, 37.02 0.75 ' +
  'c 9.74 1.76, 16.13 15.64, 18.41 25.04 ' +
  'L 357 378 Z ' +
  // Right pec, upper half. Segments 3–7 of the library's right-pec
  // path traced up-then-across-then-down to top-outer.
  'M 374 378 ' +
  'L 380.27 326.55 ' +
  'c 4.26 -6.26, 10.49 -7.93, 18.36 -8.56 ' +
  'q 11.66 -0.92, 23.32 -0.35 ' +
  'c 10.58 0.53, 18.02 2.74, 26.62 7.87 ' +
  'c 12.81 7.65, 19.73 14.52, 22.67 29.75 ' +
  'L 463 378 Z';

const CHEST_LOWER: string =
  // Left pec, lower half. Segments 5–8 of the library's left-pec path
  // (inner edge going down, across the bottom, back up outer edge).
  'M 357 378 ' +
  'L 357.34 392.03 ' +
  'q -1.35 14.35, -2.05 16.89 ' +
  'c -6.52 23.5, -38.08 29.23, -58.28 24.53 ' +
  'c -9.12 -2.12, -17.24 -4.38, -24.1 -10.61 ' +
  'L 266 378 Z ' +
  // Right pec, lower half. Segments 7–9 + partial 1–3 of the library's
  // right-pec path.
  'M 463 378 ' +
  'L 471.24 355.26 ' +
  'c 4.94 25.57, 0.24 64.14, -28.21 74.97 ' +
  'q -12.26 4.67, -26.99 4.77 ' +
  'c -15.12 0.11, -34.46 -6.78, -41.37 -21.48 ' +
  'q -1.88 -3.99, -2.84 -12.18 ' +
  'L 374 378 Z';

// ── Shoulders (deltoid heads) ────────────────────────────────────────
//
// Front-view deltoid slug (bodyFront.js:122) covers ANTERIOR + LATERAL
// heads together. Split boundary at x=236 (left delt) / x=487 (right
// delt) — anatomically the fibre boundary between the two heads.
//
//   Left front delt trace (clockwise from top-inner near pec):
//     (274.06, 311.69) top-inner  →  (278.39, 319.83) small dip  →
//     (249.19, 340.31) inner-mid  →  (247.76, 363.99) inner-lower  →
//     (242.03, 378.06) mid-inner  →  (228.22, 394.73) bottom-mid  →
//     (217.53, 394.26) bottom-outer →  (195.01, 351.04) outer-side  →
//     (219.07, 316.02) top-outer   →  back to start via top-arc.
//
//   Right front delt trace (clockwise from bottom-inner near pec):
//     (450.39, 320.75) bottom-inner → (461.83, 307.27) top-inner  →
//     (522.00, 328.01) top-outer    → (507.18, 396.20) bottom-outer  →
//     (497.37, 391.69) →  (481.38, 368.89) inner-lower  →
//     (471.74, 331.27) inner-upper  →  back to start.
//
// ANTERIOR HEAD = medial portion (higher x on left delt, lower x on
// right delt). Uses the pec-side inner edge segments verbatim.
//
// LATERAL HEAD = outer portion (lower x on left delt, higher x on
// right delt). Uses the outer-arc segments verbatim.

const SHOULDERS_FRONT_DELT: string =
  // Left anterior head — traces the inner edge from top-inner down to
  // (242, 378) using library segments 1–4 verbatim, then closes with a
  // vertical line up the anatomical midline of the delt (x=236) and a
  // Q curve back to the top-inner corner.
  'M 274.06 311.69 ' +
  'q 3.94 2.77, 4.33 8.14 ' +
  'c -9.98 5.88, -24.35 7.45, -28.82 19.75 ' +
  'c -2.31 6.36, -0.97 17.35, -1.43 23.68 ' +
  'q -0.55 7.51, -5.73 14.07 ' +
  'L 236 380 ' +
  'L 236 320 ' +
  'Q 253 313, 274.06 311.69 Z ' +
  // Right anterior head — traces the top-inner curve up to (461, 307),
  // then a Q across to the delt midline (x=487), then a straight line
  // down, then the inner-lower c segment back to top and a q closure.
  'M 450.39 320.75 ' +
  'q -0.95 -0.52, -0.7 -1.58 ' +
  'c 1.57 -6.61, 5.8 -9.1, 12.14 -11.9 ' +
  'Q 476 305, 487 318 ' +
  'L 487 372 ' +
  'L 481.38 368.89 ' +
  'c -3.93 -13.43, 4.32 -27.54, -9.64 -37.62 ' +
  'q -8.22 -5.93, -17.99 -9.08 ' +
  'q -1.84 -0.59, -3.36 -1.44 Z';

const SHOULDERS_SIDE_DELT: string =
  // Left lateral head — the outer cap of the shoulder. Segments 5–7
  // of the left delt path (bottom-outer, outer-side, top-outer)
  // verbatim, plus a straight L across the delt midline at x=236 to
  // close.
  'M 236 380 ' +
  'L 228.22 394.73 ' +
  'L 217.53 394.26 ' +
  'c -15.42 -8.87, -24.95 -25.45, -22.52 -43.22 ' +
  'c 2.05 -14.92, 12.71 -25.79, 24.06 -35.02 ' +
  'L 236 320 Z ' +
  // Right lateral head — outer-side segments of the right delt.
  'M 487 318 ' +
  'Q 505 310, 522.00 328.01 ' +
  'c 20.73 21.99, 11.81 56.44, -14.82 68.19 ' +
  'c -4.41 1.94, -6.79 -1.03, -9.81 -4.51 ' +
  'c -5.81 -6.7, -13.46 -14.12, -15.99 -22.8 ' +
  'L 487 372 Z';

// ── Back / lats ──────────────────────────────────────────────────────
//
// Built-in upper-back slug (bodyBack.js:46) covers trapezius + rhomboids
// + lats together. The lats sit in the LOWER half of that wedge and
// have a V-taper — widest under the scapula (~y=430), narrowest at the
// waist attachment (~y=580).
//
// The polygons below are hand-authored V-shapes bounded by the
// upper-back slug's outer extents:
//   Left lat:  x∈[955..1052], y∈[400..580]
//   Right lat: x∈[1120..1217], y∈[400..580]
// Symmetric across the spine at x=1086. Each side uses cubic Beziers
// to sweep from the armpit anchor down to the waist, staying inside
// the built-in upper-back path so no overlay pixels bleed past the
// muscle outline.

const BACK_LATS: string =
  // Left lat wing.
  'M 955 400 ' +
  'C 970 410, 990 425, 1010 440 ' +
  'C 1030 452, 1048 465, 1052 490 ' +
  'C 1055 515, 1050 545, 1038 575 ' +
  'L 1030 580 ' +
  'L 1020 580 ' +
  'C 1015 555, 1005 525, 990 495 ' +
  'C 975 465, 963 435, 955 400 Z ' +
  // Right lat wing — mirror across x=1086.
  'M 1217 400 ' +
  'C 1202 410, 1182 425, 1162 440 ' +
  'C 1142 452, 1124 465, 1120 490 ' +
  'C 1117 515, 1122 545, 1134 575 ' +
  'L 1142 580 ' +
  'L 1152 580 ' +
  'C 1157 555, 1167 525, 1182 495 ' +
  'C 1197 465, 1209 435, 1217 400 Z';

// ── Public lookup ────────────────────────────────────────────────────
//
// Consumers import PATHS_BY_ID and read the string; storing the paths
// as strings (not JSX) keeps this module tree-shakeable and free of a
// react-native-svg dependency — MuscleOverlay owns the SVG rendering.
//
// NOTE. `shoulders-rear` is intentionally NOT in this map. The
// library's back-view `deltoids` slug already renders the rear delt
// perfectly (the back view only sees the posterior head; there's no
// anterior/lateral confusion because those heads face forward). The
// emphasis-to-render map delegates 'shoulders-rear' to the native slug
// on the back view — same anatomical result, zero authoring drift.

export const PATHS_BY_ID: Record<MusclePathId, string> = {
  'chest-upper': CHEST_UPPER,
  'chest-lower': CHEST_LOWER,
  'back-lats': BACK_LATS,
  'shoulders-front-delt': SHOULDERS_FRONT_DELT,
  'shoulders-side-delt': SHOULDERS_SIDE_DELT,
};
