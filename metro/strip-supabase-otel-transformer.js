// Metro source transformer that neuters the OpenTelemetry dynamic import
// inlined in @supabase/supabase-js's published bundle.
//
// ─── Why ────────────────────────────────────────────────────────────────
// supabase-js's dist/index.{mjs,cjs} contains this line (from the original
// shared/tracing/extract.js module that was inlined into the bundle):
//
//   const OTEL_PKG = "@opentelemetry/api";
//   ...
//   otelModulePromise = import(
//     /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */
//     OTEL_PKG
//   ).catch(() => null);
//
// The triple comment-pragmas tell webpack / turbopack / vite to leave the
// dynamic import untouched. None of them help Hermes — Hermes can't compile
// a `import(<identifier>)` expression at all (it needs a string literal so
// Metro can statically resolve a dependency). The result on the production
// EAS build is:
//
//   index.android.bundle: error: Invalid expression encountered
//   ... = import(/* webpackIgnore */ ... OTEL_PKG).catch(...)
//
// At runtime, when `@opentelemetry/api` isn't installed (we don't ship it),
// the `.catch(() => null)` resolves the promise to null and the SDK keeps
// working. So we don't need the OTEL code path at all on React Native —
// it's dead code that just happens to be unparseable.
//
// ─── What this does ────────────────────────────────────────────────────
// Wraps the default Metro/Expo Babel transformer with a tiny pre-pass that
// replaces ONLY that one line, ONLY in files whose path is inside
// `@supabase/supabase-js`. The replacement assigns null directly, removing
// the dynamic import expression entirely so Hermes never sees it. Every
// other dynamic import in every other package is left alone.
//
// If supabase ever ships a new version where this line no longer matches,
// the regex will simply not fire (the no-op fallback) — the build won't
// silently regress on the OTEL fix because the production EAS build would
// fail at Hermes again, and we'd notice immediately.

const upstream = require('@expo/metro-config/babel-transformer');
const path = require('path');

// Anchored to the exact text the supabase-js bundle emits:
//   otelModulePromise = import(/* … */ OTEL_PKG).catch(() => null);
// Allows for whitespace/comment variation between `import(` and `OTEL_PKG`,
// and matches the exact `.catch(() => null)` tail supabase ships.
//
// Deliberately narrow — must not match unrelated dynamic imports. An earlier
// version used `\.catch\([^)]*\)` which prematurely stopped at the `()` in
// the arrow function, leaving `=> null);` dangling and producing a syntax
// error. We now match the arrow literally.
const SUPABASE_OTEL_IMPORT =
  /import\(\s*(?:\/\*[^*]*\*\/\s*)*OTEL_PKG\s*\)\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/g;

function isSupabaseSdkFile(filename) {
  if (!filename) return false;
  // Normalize Windows paths so the includes() check works on both platforms.
  const normalized = filename.split(path.sep).join('/');
  return normalized.includes('/@supabase/supabase-js/');
}

module.exports.transform = function transform(args) {
  const { filename, src } = args;
  if (isSupabaseSdkFile(filename) && SUPABASE_OTEL_IMPORT.test(src)) {
    // Reset lastIndex since the test() call advanced it on the /g regex.
    SUPABASE_OTEL_IMPORT.lastIndex = 0;
    const patchedSrc = src.replace(SUPABASE_OTEL_IMPORT, 'Promise.resolve(null)');
    return upstream.transform({ ...args, src: patchedSrc });
  }
  return upstream.transform(args);
};
