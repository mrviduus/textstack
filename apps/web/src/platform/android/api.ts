import { initApi, isTokenExpiring } from '@textstack/shared'
import { API_BASE } from '../../api/base'
import { emitAuthFailure } from './authEvents'
import { SecureStore } from './native'

const API_URL = API_BASE

/**
 * `X-App-Version` / `X-App-Build` on every request, so the server can tell which build is calling (review #23).
 * ponytail: empty until the shell (#1643) gives the installed version. The auth routes add `X-Client: mobile`
 * themselves (shared `authApi`).
 */
export const APP_HEADERS: Record<string, string> = {}

/**
 * Single-flight guard: multiple concurrent 401s share one refresh call.
 * Without this the server would invalidate the first rotated refresh
 * token mid-flight and the second caller would get stuck in a loop.
 */
let refreshPromise: Promise<string | null> | null = null

/**
 * True once we've emitted an auth-failure for the *current* session.
 * Prevents floods of signOut()s when 20 hooks all fire after a stale
 * token. Reset on successful refresh or explicit sign-in.
 */
let authFailureLatched = false

/**
 * Read the current Bearer access token. Exported so a future PDF WebView bootstrap
 * (ADR-012 S4b) can inject it into pdf.js `httpHeaders` — mobile has no cookies, so
 * the Original-layout viewer authenticates the file fetch via this token. Behavior
 * (and the shared client's single-flight refresh via `onUnauthorized`) is unchanged.
 */
export async function getAccessToken(): Promise<string | null> {
  return (cached = await SecureStore.getItemAsync('access_token'))
}

/** The access token as last read or written here, for a call that cannot wait (`transport.fetchInit` in `pagehide`). */
let cached: string | null = null
export const cachedAccessToken = () => cached

/** A new session's tokens (sign-in, guest mint). */
export async function writeTokens(accessToken: string, refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync('access_token', accessToken)
  await SecureStore.setItemAsync('refresh_token', refreshToken)
  cached = accessToken
}

/** The session's tokens gone (sign-out, a deleted account). */
export async function clearTokens(): Promise<void> {
  cached = null
  await SecureStore.deleteItemAsync('access_token')
  await SecureStore.deleteItemAsync('refresh_token')
}

/** Clears tokens and notifies the AuthContext (once) that the session is gone. */
async function handleTerminalAuthFailure(): Promise<void> {
  cached = null
  await SecureStore.deleteItemAsync('access_token').catch(() => {})
  await SecureStore.deleteItemAsync('refresh_token').catch(() => {})
  if (!authFailureLatched) {
    authFailureLatched = true
    emitAuthFailure()
  }
}

/**
 * Single-flight token refresh. Exported so the Original-layout PDF viewer
 * (ADR-012 S4b) can recover from a mid-read Range 401: the WebView posts
 * `pdfAuthExpired`, RN calls this to refresh, then rebuilds the viewer source
 * with the fresh Bearer token (no visible banner). Shares the same in-flight
 * promise as the shared API client so concurrent 401s don't rotate twice.
 */
export async function onUnauthorized(opts?: { quiet?: boolean }): Promise<string | null> {
  if (refreshPromise) return refreshPromise
  // `quiet`: the caller is a sign-in/sign-up (`authApi`'s pre-merge refresh). A
  // rejected refresh there must not wipe the guest keys or fire auth-failure —
  // that signs the reader out of the very guest row they are trying to keep, and
  // races the new tokens the sign-in is about to write. They just get no bearer.
  // ponytail: a normal 401 that joins an in-flight quiet refresh inherits its
  // quietness; the next 401 after that is terminal as usual.
  const terminal = opts?.quiet ? async () => {} : handleTerminalAuthFailure

  refreshPromise = (async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync('refresh_token')
      if (!refreshToken) {
        await terminal()
        return null
      }

      let res: Response
      try {
        res = await fetch(`${API_URL}/auth/refresh-mobile`, {
          method: 'POST',
          headers: { ...APP_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
      } catch {
        // Network failure — keep the refresh token around so a retry
        // when we're back online can still succeed. Do NOT clear tokens
        // and do NOT emit a terminal auth failure.
        return null
      }

      if (!res.ok) {
        // Explicit rejection by the server (401/403/410) — session is
        // really gone. Wipe tokens and tell the UI.
        if (res.status >= 400 && res.status < 500) {
          await terminal()
        }
        return null
      }

      const data = await res.json()
      await writeTokens(data.accessToken, data.refreshToken)
      authFailureLatched = false
      return data.accessToken as string
    } catch {
      return null
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

/**
 * A token that is good to spend on a file download, refreshed first if it is
 * close to expiry.
 *
 * `File.downloadFileAsync` reports every failure as a thrown error with no
 * status, so a 401 from it is indistinguishable from the device being offline —
 * there is no "retry after the refresh" to fall back on. Refreshing before
 * spending is the only order that works, and the file callers
 * (`reader/deviceDownload.ts`, `shareOriginal.ts`) share this one copy of it.
 */
export async function freshAccessToken(): Promise<string | null> {
  const token = await getAccessToken()
  if (token && !isTokenExpiring(token)) return token
  return onUnauthorized()
}

/** Reset the latch so a re-login in the same process can trigger signOut again later. */
export function resetAuthFailureLatch(): void {
  authFailureLatched = false
}

export function setupApi() {
  initApi({ baseUrl: API_URL, getAccessToken, onUnauthorized, headers: APP_HEADERS })
}

export { API_URL }
