import type { Platform } from '.'
import { account } from './android/account'
import { isTokenExpiring } from '@textstack/shared'
import { applyMergeMap } from '../lib/mergeMap'
import { APP_HEADERS, cachedAccessToken, freshAccessToken, getAccessToken, setupApi } from './android/api'
import { google } from './android/google'
import { clearImages, imageSrc } from './android/imageSrc'
import { library, syncSoon } from './android/library'
import { NetInfo } from './android/native'
import { highlights, vocabulary } from './android/vocabulary'
import { startSyncProbe } from './android/syncClient'

// The shared API client in bearer mode, on load (`web.ts` sets cookie mode the same way).
setupApi()
// The token cache filled at once, so the first synchronous `fetchInit` of a stored session carries it.
void getAccessToken().catch(() => {})
// A library pass when the network comes back and when the app is shown again (Expo DownloadContext, #1598).
NetInfo.addEventListener((s) => { if (s.isConnected) syncSoon() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncSoon() })

/** The Android shell (ADR-035): a local SQLite library, device files, bearer tokens. */
export const platform: Platform = {
  transport: {
    // Synchronous (a `pagehide` write uses it), so the token is the cached copy; never throws. A copy close to
    // expiry is refreshed in the background, so the next call carries a good one (no caller retries a 401).
    fetchInit: () => {
      const token = cachedAccessToken()
      if (token && isTokenExpiring(token)) void freshAccessToken().catch(() => {})
      return { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }
    },
  },
  account,
  session: {
    // The V2 probe once a user is set (the Expo AuthContext's userId effect), then a library pass.
    // A session's first pass retries what an earlier one stopped (`retryFailed`).
    userSet: () => void startSyncProbe().then(() => syncSoon(true), (e: unknown) => console.warn('[v2] status probe failed:', e)),
    settled: () => {},
    // account.ts bumps its session epoch where the tokens change (`sessionEpoch`), before the UI knows.
    // The covers held in memory are the previous account's.
    accountChanged: clearImages,
    // account.ts already claimed the device library and adopted a guest's. The web stores in the WebView
    // (localStorage progress, offlineDb queues) are re-keyed as on the web.
    signedIn: async (merge) => { if (merge) await applyMergeMap(merge) },
    restored: async () => syncSoon(true),
  },
  siteChrome: false,
  imageSrc,
  google,
  library,
  vocabulary,
  highlights,
}
