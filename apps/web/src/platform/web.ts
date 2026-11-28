import { highlightCoverUrl, highlightsApi, initApi } from '@textstack/shared'
import type { Platform } from '.'
import { API_BASE } from '../api/base'
import * as auth from '../api/auth'
import { settleSyncSession, startSyncProbe, syncStore } from '../api/sync'
import { replayAllPendingHighlights } from '../lib/highlightSync'
import { applyMergeMap } from '../lib/mergeMap'
import { initGoogleSignIn, renderGoogleButton, signOutOfGoogle } from '../lib/googleSignIn'
import * as userBooks from '../api/userBooks'
import * as vocabulary from '../api/vocabulary'

// The shared API client in cookie mode: no bearer token. A 401 refreshes the cookie (single-flight in
// `refreshToken`), then the client retries once. `''` means "retry with the cookie only".
initApi({
  baseUrl: API_BASE,
  getAccessToken: async () => null,
  onUnauthorized: () => auth.refreshToken().then(() => '', () => null),
  credentials: 'include',
})

/** The web app: the session is an HttpOnly cookie. */
export const platform: Platform = {
  transport: {
    fetchInit: () => ({ credentials: 'include' }),
  },
  account: auth,
  session: {
    userSet: () => { void startSyncProbe() },
    settled: () => settleSyncSession(),
    accountChanged: () => syncStore.reset(),
    // The in-memory cache was emptied by the account change; then the highlights made without a session go out.
    signedIn: async (merge) => {
      if (merge) await applyMergeMap(merge)
      void replayAllPendingHighlights()
    },
    restored: () => replayAllPendingHighlights(),
  },
  siteChrome: true,
  appShell: false,
  imageSrc: (url) => url,
  onBackButton: () => () => {},
  google: {
    init: (onIdToken) => initGoogleSignIn(onIdToken),
    renderButton: (el) => renderGoogleButton(el),
    signOut: () => signOutOfGoogle(),
  },
  library: { ...userBooks, withoutSession: false },
  vocabulary,
  highlights: {
    getAllHighlights: (q) => highlightsApi.getAllHighlights(q),
    coverUrl: highlightCoverUrl,
  },
}
