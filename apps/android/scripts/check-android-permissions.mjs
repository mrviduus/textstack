#!/usr/bin/env node
// Fails if the shell's merged release manifest asks for a permission not listed here (ADR-035: the shell asks
// for the Expo app's permissions or fewer). Plugins add permissions at merge time, so the source manifest is
// not enough: run `./gradlew :app:processReleaseMainManifest` in android/ first.
// Block an unwanted one in android/app/src/main/AndroidManifest.xml with tools:node="remove";
// adopt a new one here with the reason, and update the Play listing and Data safety form to match.
import { existsSync, readFileSync } from 'node:fs'

const MERGED = new URL(
  '../android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml',
  import.meta.url,
).pathname

const ALLOWED = new Map([
  ['android.permission.INTERNET', 'the app syncs with textstack.app'],
  ['android.permission.ACCESS_NETWORK_STATE', 'offline detection (@capacitor/network)'],
  ['android.permission.USE_BIOMETRIC', 'Keystore-backed token storage (capacitor-secure-storage)'],
  ['android.permission.USE_FINGERPRINT', 'Keystore-backed token storage on older devices (capacitor-secure-storage)'],
  ['app.textstack.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION', 'app-scoped, declared by androidx.core'],
])

if (!existsSync(MERGED)) {
  console.error(`✗ No merged manifest at ${MERGED}\n  Run: cd android && ./gradlew :app:processReleaseMainManifest`)
  process.exit(1)
}
const requested = [...readFileSync(MERGED, 'utf8').matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map((m) => m[1])
const unexpected = requested.filter((p) => !ALLOWED.has(p))
for (const p of requested.filter((p) => ALLOWED.has(p))) console.log(`  ok  ${p}  (${ALLOWED.get(p)})`)
if (unexpected.length) {
  console.error(`✗ ${unexpected.length} permission(s) not allowed:\n  ${unexpected.join('\n  ')}`)
  process.exit(1)
}
console.log(`✓ ${requested.length} permission(s), all allowed.`)
