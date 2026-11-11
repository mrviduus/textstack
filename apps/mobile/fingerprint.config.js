/**
 * Expo fingerprint (runtimeVersion policy "fingerprint"). The pnpm patches at the workspace root change native code
 * (patches/react-native-webview@*.patch, #1228) without touching any file the fingerprint reads by default (it hashes
 * react-native-webview's package.json, not its android/ sources): without this source an OTA built with the patch
 * would be offered to a store build without it.
 * @type {import('expo/fingerprint').Config}
 */
module.exports = {
  extraSources: [{ type: 'dir', filePath: '../../patches', reasons: ['pnpm patches (native code)'] }],
}
