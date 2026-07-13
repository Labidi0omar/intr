// Runs ESLint on the reanimated shim canary and INVERTS the exit code.
// Exit 0 iff the canary reports at least one error — i.e. the
// reanimated/js-function-in-worklet rule actually fired on a known bug.
//
// Purpose: eslint-plugin-reanimated 2.0.1 is aging (built for
// typescript-eslint v5 + ESLint v8) and we're already shimming it for
// v8 + v9 compat via eslint-shims/reanimated.js. If ESLint,
// typescript-eslint, or the plugin change again and the shim drifts,
// the rule can go silent — reporting zero findings on every file,
// including real bugs. That's exactly how the "The easing function
// is not a worklet" bug shipped past a green `npm run lint` before.
//
// This canary catches that failure mode by asserting "when I run the
// rule on a file with a known violation, it MUST find it." A silent
// rule = failing script = loud alarm.
//
// Wire this into any pre-commit / CI step next to `npm run lint`.
const path = require('node:path');
const { ESLint } = require('eslint');

const CANARY = 'eslint-shims/__canary__/known-bad-worklet.tsx';
const EXPECTED_RULE = 'reanimated/js-function-in-worklet';

(async () => {
  const eslint = new ESLint({ cwd: path.resolve(__dirname, '..') });
  const report = await eslint.lintFiles([CANARY]);
  const messages = report.flatMap((f) => f.messages);
  const ruleHits = messages.filter((m) => m.ruleId === EXPECTED_RULE && m.severity === 2);
  runAssertion(ruleHits);
})().catch((err) => {
  console.error('[canary] eslint failed to run:', err.message);
  process.exit(2);
});

function runAssertion(ruleHits) {

if (ruleHits.length === 0) {
  console.error('');
  console.error('  ✗ CANARY FAILED');
  console.error('');
  console.error(`    Expected the ${EXPECTED_RULE} rule to fire on ${CANARY},`);
  console.error(`    but the file linted clean. That means the eslint-shims/reanimated.js shim,`);
  console.error(`    or the underlying plugin, has gone silent — the rule is not catching`);
  console.error(`    known worklet-boundary bugs. Real bugs will now ship past 'npm run lint'.`);
  console.error('');
  console.error(`    Debug: run  npx eslint --format json ${CANARY}`);
  console.error(`    Investigate: has eslint-plugin-reanimated updated? typescript-eslint?`);
  console.error(`    Fix the shim in eslint-shims/reanimated.js before merging.`);
  console.error('');
  process.exit(1);
}

console.log(`OK reanimated shim canary passed — rule fired on ${CANARY} (${ruleHits.length} finding${ruleHits.length === 1 ? '' : 's'})`);
process.exit(0);
}
