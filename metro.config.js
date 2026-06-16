// Metro config — extends Expo's default and points the Babel transformer
// at a tiny wrapper that strips one unparseable line from supabase-js's
// bundle. See ./metro/strip-supabase-otel-transformer.js for the full
// rationale (Hermes can't compile `import(<identifier>)`; supabase ships
// it inlined; the line is dead code on React Native anyway).
//
// Nothing else is customized — defaults are kept so future Expo upgrades
// roll cleanly.

const { getDefaultConfig } = require('@expo/metro-config');

const config = getDefaultConfig(__dirname);

config.transformer.babelTransformerPath = require.resolve(
  './metro/strip-supabase-otel-transformer.js',
);

module.exports = config;
