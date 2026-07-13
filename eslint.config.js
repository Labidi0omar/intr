// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expoConfig = require('eslint-config-expo/flat');
// Local shim over eslint-plugin-reanimated — the upstream plugin was
// written for @typescript-eslint v5's parserServices shape and its
// rule silently no-ops under v8. See eslint-shims/reanimated.js for
// the full explanation. Retire the shim when upstream ships a v8-
// compatible release.
const reanimatedPlugin = require('./eslint-shims/reanimated');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  // Type-aware worklet checks. eslint-plugin-reanimated needs full
  // TS type information (a real ts.Program) to walk callee signatures
  // — that's why we opt-in with parserOptions.project on this scoped
  // block only. `parser: tsParser` must be respecified here too:
  // flat-config languageOptions completely override, not merge, so
  // omitting it drops back to espree (no services, silent rule).
  // Scoped to files that define or consume motion/worklet sites.
  {
    files: [
      'src/components/motion/**/*.{ts,tsx}',
      'app/(tabs)/home.tsx',
      'app/workout.tsx',
      // Shim canary — this file contains a known worklet-boundary bug
      // the rule MUST catch. The lint:reanimated-canary script inverts
      // the exit code so the rule going silent (shim drift) is loud.
      'eslint-shims/__canary__/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      reanimated: reanimatedPlugin,
    },
    rules: {
      // Flags calls to non-worklet functions from inside a worklet body.
      // Catches bugs like "The easing function is not a worklet" at lint
      // time instead of on device.
      'reanimated/js-function-in-worklet': 'error',
    },
  },
]);
