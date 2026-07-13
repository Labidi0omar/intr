// SHIM CANARY — do not "fix" this file.
//
// This file contains a KNOWN worklet-boundary violation the
// eslint-plugin-reanimated rule (via eslint-shims/reanimated.js) must
// catch. The `npm run lint:reanimated-canary` script runs lint on
// this file alone and inverts the exit code: if the rule reports
// zero errors, the script fails loudly. That's the alarm for the
// shim silently breaking after a package upgrade.
//
// If ESLint / typescript-eslint / eslint-plugin-reanimated change
// again and the shim drifts, THIS is where you find out — not on
// device with a fresh "not a worklet" red-screen.
//
// KEEP: the JS-thread call inside the worklet body. It is the whole
// point.
import { useAnimatedProps, useSharedValue } from 'react-native-reanimated';

// Plain JS-thread function — no 'worklet' directive.
function jsThreadOnly(n: number): string {
  return n.toLocaleString();
}

export function KnownBadWorklet() {
  const shared = useSharedValue(0);
  const props = useAnimatedProps(() => {
    // reanimated/js-function-in-worklet MUST flag this call.
    const text = jsThreadOnly(shared.get());
    return { text };
  });
  return props;
}
