// Adds Instagram to AndroidManifest <queries> so Linking.canOpenURL and
// react-native-share can detect it on Android 11+ (API 30+), which enforces
// package visibility restrictions by default.
//
// Without this, `Linking.canOpenURL('instagram://app')` returns false even
// when Instagram is installed.

const { withAndroidManifest } = require('@expo/config-plugins');

const INSTAGRAM_PACKAGE = 'com.instagram.android';
const SCHEMES = ['instagram', 'instagram-stories'];

function ensureArray(parent, key) {
  if (!parent[key]) parent[key] = [];
  return parent[key];
}

module.exports = function withInstagramQueries(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // <queries> is a sibling of <application>, directly under <manifest>.
    const queriesList = ensureArray(manifest, 'queries');
    if (queriesList.length === 0) queriesList.push({});
    const queries = queriesList[0];

    // 1) Explicit package declaration
    const pkgs = ensureArray(queries, 'package');
    const alreadyDeclared = pkgs.some(
      (p) => p?.$?.['android:name'] === INSTAGRAM_PACKAGE
    );
    if (!alreadyDeclared) {
      pkgs.push({ $: { 'android:name': INSTAGRAM_PACKAGE } });
    }

    // 2) Intent filter for instagram:// and instagram-stories:// schemes
    const intents = ensureArray(queries, 'intent');
    for (const scheme of SCHEMES) {
      const exists = intents.some((it) =>
        (it?.data ?? []).some((d) => d?.$?.['android:scheme'] === scheme)
      );
      if (!exists) {
        intents.push({
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          data: [{ $: { 'android:scheme': scheme } }],
        });
      }
    }

    return config;
  });
};
