#!/usr/bin/env node
// Fails if the Android manifest requests a permission we did not sanction.
//
// Why this exists: `RECORD_AUDIO` and `SYSTEM_ALERT_WINDOW` shipped to Play Internal
// Testing for months. Neither was ours — config plugins (expo-audio /
// expo-image-picker, and expo-dev-launcher) inject them at prebuild time, into the
// shared main manifest, in release builds too. A microphone permission with no
// microphone feature behind it is the kind of thing a store reviewer asks about.
// `app.json` -> android.blockedPermissions strips them; this guard makes sure the
// next `expo install` cannot quietly put them back.
//
// Reads the MERGED release manifest when one exists, because the source manifest is
// blind to everything the libraries contribute — the source lists ~10 permissions,
// the merge produces ~35. Only the merged view resembles what Play shows a user.
//
//   npx expo prebuild --platform android --clean          # level 1 (source)
//   cd android && ./gradlew :app:processReleaseMainManifest   # level 2 (merged)
//   npm run check:permissions
//
// Two levels still live outside this script, and both matter before production:
//   3. the real artifact:  bundletool dump manifest --bundle=app.aab
//      (EAS can build differently from your laptop — lockfile, plugin resolution)
//   4. Play Console -> App bundle explorer -> Permissions — the only view that is
//      authoritative about what the reviewer sees.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MERGED = resolve(
  MOBILE_ROOT,
  'android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml',
)
const SOURCE = resolve(MOBILE_ROOT, 'android/app/src/main/AndroidManifest.xml')

// Every permission we consciously ship, and the reason. Adding a line here is a
// deliberate act: it means answering for that permission in the Play listing and, if
// it is a sensitive one, in a permissions declaration form.
const ALLOWED = new Map([
  ['android.permission.INTERNET', 'the app is a networked reader'],
  ['android.permission.ACCESS_NETWORK_STATE', 'offline detection (@react-native-community/netinfo)'],
  ['android.permission.ACCESS_WIFI_STATE', 'offline detection (@react-native-community/netinfo)'],
  ['android.permission.VIBRATE', 'haptics (useHaptics) and notification vibration'],
  ['android.permission.MODIFY_AUDIO_SETTINGS', 'TTS audio focus / routing (expo-audio setAudioModeAsync)'],
  ['android.permission.POST_NOTIFICATIONS', 'vocabulary review reminders (src/lib/vocabReminder.ts)'],
  ['android.permission.RECEIVE_BOOT_COMPLETED', 'rescheduling reminders after reboot (expo-notifications)'],
  ['android.permission.WAKE_LOCK', 'delivering a scheduled reminder (expo-notifications)'],
  ['android.permission.USE_BIOMETRIC', 'keystore-backed token storage (expo-secure-store)'],
  ['android.permission.USE_FINGERPRINT', 'keystore-backed token storage on older devices (expo-secure-store)'],
  ['android.permission.READ_EXTERNAL_STORAGE', 'document picker on API <= 32 (maxSdkVersion 32, inert above)'],
  ['android.permission.WRITE_EXTERNAL_STORAGE', 'document picker on API <= 32 (maxSdkVersion 32, inert above)'],
  ['com.google.android.c2dm.permission.RECEIVE', 'push transport used by expo-notifications'],
  ['com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE', 'Play Services install referrer'],
])

// Self-scoped receiver permission Expo defines for this package. Not user-visible.
const ALLOWED_PATTERNS = [
  [/^app\.textstack\.mobile\./, 'app-scoped internal permission declared by Expo'],
]

// Requested, tolerated, but not yet justified — warned about on every run so they
// cannot settle into the background.
//
// FOREGROUND_SERVICE / FOREGROUND_SERVICE_MEDIA_PLAYBACK used to sit here. expo-audio
// adds them (plus AudioControlsService, foregroundServiceType=mediaPlayback) unless
// its plugin gets `enableBackgroundPlayback: false` — which app.json now sets
// (2026-10-07). The service only starts from player.setActiveForLockScreen(), which
// this app never calls; TTS is foreground-only. Their presence made Play demand the
// foreground-service declaration and blocked releases. They are deliberately in
// neither list now, so if one comes back this script fails as "unsanctioned".
const WATCH = new Map()

// ShortcutBadger, pulled in transitively by expo-notifications, requests a launcher
// permission for every OEM it knows about. The app never sets a badge count. These
// are invisible in the source manifest and only appear after a merge — but they DO
// appear in the Play listing, where "read your settings" and "install shortcuts"
// read alarmingly for a reading app. Candidate for a bulk block once someone
// confirms no notification path depends on a badge.
const WATCH_PATTERNS = [
  [/badge|badger|launcher/i, 'ShortcutBadger via expo-notifications; app never sets a badge'],
]

const manifestPath = existsSync(MERGED) ? MERGED : SOURCE
const level = manifestPath === MERGED ? 'merged release' : 'source'

if (!existsSync(manifestPath)) {
  console.error(`✗ No manifest at ${SOURCE}`)
  console.error('  android/ is gitignored — this is a managed-prebuild app. Generate it:')
  console.error('    npx expo prebuild --platform android --clean')
  process.exit(1)
}

if (manifestPath === SOURCE) {
  console.warn('! Reading the SOURCE manifest — it does not include anything the')
  console.warn('  libraries contribute. For the real picture, run:')
  console.warn('    cd android && ./gradlew :app:processReleaseMainManifest')
  console.warn('')
}

const xml = readFileSync(manifestPath, 'utf8')

const describe = (perm, table, patterns) =>
  table.get(perm) ?? patterns.find(([re]) => re.test(perm))?.[1]

// A <uses-permission> carrying tools:node="remove" is an instruction to the merger to
// strip the permission, not a request for it — the fix, not the problem.
const requested = []
const removed = []
for (const tag of xml.match(/<uses-permission\b[^>]*>/g) ?? []) {
  const name = tag.match(/android:name="([^"]+)"/)?.[1]
  if (!name) continue
  ;(/tools:node="remove"/.test(tag) ? removed : requested).push(name)
}

const watched = requested.filter((p) => describe(p, WATCH, WATCH_PATTERNS))
const ok = requested.filter((p) => !watched.includes(p) && describe(p, ALLOWED, ALLOWED_PATTERNS))
const unexpected = requested.filter((p) => !watched.includes(p) && !ok.includes(p))

console.log(`Manifest: ${level}`)
for (const p of ok.sort()) console.log(`  ok       ${p}  — ${describe(p, ALLOWED, ALLOWED_PATTERNS)}`)
for (const p of removed.sort()) console.log(`  removed  ${p}  — blocked via app.json android.blockedPermissions`)
for (const p of watched.sort()) console.log(`  WATCH    ${p}  — ${describe(p, WATCH, WATCH_PATTERNS)}`)

if (unexpected.length > 0) {
  console.error('')
  console.error(`✗ ${unexpected.length} unsanctioned permission(s):`)
  for (const p of unexpected.sort()) console.error(`    ${p}`)
  console.error('')
  console.error('  A dependency or config plugin added these. Either:')
  console.error('    • block it — add to app.json  expo.android.blockedPermissions, or')
  console.error('    • own it   — add it to ALLOWED in this file with the reason, and')
  console.error('                 update the Play listing + Data Safety form to match.')
  process.exit(1)
}

console.log('')
console.log(`✓ ${requested.length} permission(s), none unsanctioned.`)
if (watched.length > 0) {
  console.log(`  ${watched.length} on the WATCH list — verify on a device, then block or adopt.`)
}
