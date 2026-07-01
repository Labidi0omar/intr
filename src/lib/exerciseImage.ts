// Helpers for the free-exercise-db image URLs used by the exercise catalog.
//
// Each exercise has up to two animation frames at .../<exercise>/0.jpg and
// .../<exercise>/1.jpg (start and end position). The active-workout card
// loops between them so the user can read the movement instead of staring
// at a single ambiguous frame.

/**
 * Derive the second-frame URL from a catalog imageUrl by swapping the
 * trailing `/0.jpg` for `/1.jpg`. Returns null when the URL doesn't end in
 * `/0.jpg` (recovery exercises, anything off the free-exercise-db pattern),
 * so the caller can skip the loop and render a single frame.
 */
export function secondFrameUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.endsWith('/0.jpg')) return null;
  return url.slice(0, -'/0.jpg'.length) + '/1.jpg';
}
