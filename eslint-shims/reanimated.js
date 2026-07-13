// Compatibility shim for eslint-plugin-reanimated@2.0.1.
//
// The plugin was written against @typescript-eslint v5, which exposed
// parserServices at `context.parserServices` and set a
// `hasFullTypeInformation: true` flag on it. In @typescript-eslint v8
// (what expo/eslint-config-expo pulls today), that shape changed:
//
//   - parserServices moved to `context.sourceCode.parserServices`.
//   - `hasFullTypeInformation` is no longer set publicly. The signal
//     that the parser produced a real ts.Program is that
//     `services.program` is defined.
//
// The plugin's rule reads the old location and short-circuits, so the
// worklet-boundary check silently no-ops. Without this shim, the lint
// rule reports zero findings even on an obvious bug (which is exactly
// what happened to us — the "The easing function is not a worklet"
// bug shipped past a green `npm run lint`).
//
// This shim wraps the upstream rule's `create` in a Proxy that forwards
// every property except `parserServices`, which it patches to expose
// `program` and `hasFullTypeInformation: true` from the modern
// sourceCode.parserServices object. Everything else — the rule's meta,
// its worklet detection, its TS checker walks — is the upstream code
// unmodified.
//
// When eslint-plugin-reanimated ships a v8-compatible release, delete
// this file and register the plugin directly in eslint.config.js.

const upstream = require('eslint-plugin-reanimated');

function shimContext(context) {
  const services = context.sourceCode && context.sourceCode.parserServices;
  if (!services || !services.program) {
    // No TS project wired for this file — nothing to shim, let the
    // upstream rule's own guard short-circuit as it would normally.
    return context;
  }
  // Build a services object the upstream v5-era rule accepts: it needs
  // `program`, `esTreeNodeToTSNodeMap`, and truthy `hasFullTypeInformation`.
  const shimmedServices = new Proxy(services, {
    get(target, prop) {
      if (prop === 'hasFullTypeInformation') return true;
      return target[prop];
    },
  });
  // Track the current node the rule is visiting so the getScope() shim
  // knows which scope to look up. ESLint 9 removed context.getScope();
  // sourceCode.getScope(node) replaces it. The plugin's visitors call
  // getScope() without an argument, so we intercept report() to snapshot
  // the currentNode isn't reliable — instead we wrap every visitor to
  // set a currentNode local variable via a monkey-patched create.
  // (Handled in wrapRule below by wrapping every visitor return value.)
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'parserServices') return shimmedServices;
      return target[prop];
    },
  });
}

function shimContextWithGetScope(context, currentNodeRef) {
  const inner = shimContext(context);
  // Add getScope() by forwarding to sourceCode.getScope(currentNode).
  // ESLint 9 requires an explicit node; the currentNodeRef object is
  // mutated by wrapRule's visitor wrappers so each getScope() call
  // sees the correct visited node.
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'getScope') {
        return () => target.sourceCode.getScope(currentNodeRef.node ?? target.sourceCode.ast);
      }
      return target[prop];
    },
  });
}

function wrapRule(rule) {
  return {
    ...rule,
    create(context) {
      // currentNodeRef.node is updated by each visitor wrapper below so
      // getScope() (shimmed) can pass the correct node to
      // sourceCode.getScope(node).
      const currentNodeRef = { node: null };
      const shimmed = shimContextWithGetScope(context, currentNodeRef);
      const visitors = rule.create(shimmed);
      // Wrap each visitor to update currentNodeRef before invocation.
      const wrapped = {};
      for (const [key, handler] of Object.entries(visitors)) {
        if (typeof handler === 'function') {
          wrapped[key] = (node, ...rest) => {
            currentNodeRef.node = node;
            return handler(node, ...rest);
          };
        } else {
          wrapped[key] = handler;
        }
      }
      return wrapped;
    },
  };
}

module.exports = {
  rules: Object.fromEntries(
    Object.entries(upstream.rules).map(([name, rule]) => [name, wrapRule(rule)]),
  ),
};
