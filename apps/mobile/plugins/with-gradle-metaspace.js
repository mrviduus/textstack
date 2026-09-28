// Expo config plugin: raises the JVM metaspace ceiling in the generated
// android/gradle.properties.
//
// Expo's template writes `-Xmx2048m -XX:MaxMetaspaceSize=512m`, and on SDK 57
// that is no longer enough: `:expo-updates:kspReleaseKotlin` dies with a bare
// `Metaspace` failure partway through a release build. Found building SDK 57
// locally for the first time — the Metro bundle, `expo export` and every unit
// test pass without ever starting Gradle, so nothing in CI can see it.
//
// **This is not a "my laptop is small" fix.** `MaxMetaspaceSize` is a hard cap
// on the JVM, independent of how much memory the machine has, so an EAS worker
// would hit the same wall at the same place. The heap number is raised with it
// because a KSP pass that needs more class metadata generally needs more heap
// too, and 4 GB is comfortably inside what both EAS and a dev machine have.
//
// It belongs in a plugin rather than in `android/gradle.properties` because
// that file is generated: `expo prebuild` overwrites it, and the android/
// directory is gitignored precisely so nobody hand-edits it (a stale one also
// poisons the `expo-updates` runtime fingerprint, which is how an OTA silently
// reaches nobody).
//
// Revisit when Expo raises the template default — at that point this can go.

const { withGradleProperties } = require('expo/config-plugins');

const KEY = 'org.gradle.jvmargs';
const VALUE = '-Xmx4096m -XX:MaxMetaspaceSize=2048m';

module.exports = function withGradleMetaspace(config) {
  return withGradleProperties(config, (config) => {
    const existing = config.modResults.find(
      (item) => item.type === 'property' && item.key === KEY
    );
    if (existing) {
      existing.value = VALUE;
    } else {
      config.modResults.push({ type: 'property', key: KEY, value: VALUE });
    }
    return config;
  });
};
