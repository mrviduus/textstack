import { getApiConfig } from './client'
import { isTokenExpiring } from './tokenExpiry'
import type { MobileAuthResponse, AuthResponse } from '../types/api'

/**
 * A merge entry point's answer, plus whether a bearer actually went out with
 * the request. `guestMergeSkipped == null` alone cannot tell "merged" from
 * "there was no guest to merge" — the server only reports a skip for a token it
 * saw. So "your progress moved" is claimed only when this is true too.
 */
export type MobileAuthResult = MobileAuthResponse & { sentBearer: boolean }

/**
 * `onUnauthorized` as mobile implements it: `{ quiet: true }` refreshes without
 * the terminal side effects (wiping the stored tokens, firing auth-failure).
 * Typed here rather than on `ApiConfig` because only this file passes it; a
 * client that ignores the argument (web) is still a valid one.
 */
type QuietRefresh = (opts?: { quiet?: boolean }) => Promise<string | null>

async function mobilePost(path: string, body: unknown): Promise<MobileAuthResult> {
  const { baseUrl, getAccessToken, onUnauthorized, headers: base } = getApiConfig()
  const headers: Record<string, string> = {
    ...base,
    'Content-Type': 'application/json',
    'X-Client': 'mobile',
  }
  // Carry the current session token into sign-up/sign-in. The server decides
  // whether a guest's data gets merged into the account by reading the
  // `is_guest` claim off this header first and the cookie second
  // (AuthEndpoints.GetGuestUserId). Mobile has no cookies, so without the
  // header the server sees no guest at all: MergeGuestAsync never runs and
  // everything the guest saved — vocabulary, highlights, bookmarks, notes,
  // reading sessions, progress, library rows, goals — is orphaned the moment
  // they register. Sending a *real* user's token is inert: no `is_guest`
  // claim means GetGuestUserId returns null and nothing is reparented.
  //
  // Reading the token must not be able to break sign-in. Before this call
  // existed, `/auth/login` and `/auth/register` never touched storage at all;
  // a keychain that throws (locked device, corrupted entry, missing native
  // module) would otherwise turn "we could not read your old guest token" into
  // "you cannot sign in". No token is a fully supported state — take it.
  let token: string | null = null
  try {
    token = await getAccessToken()
  } catch {
    token = null
  }
  // An EXPIRED bearer here is worse than none: the server ignores it silently
  // and answers 200, so the merge never runs and nothing surfaces the loss.
  // Access tokens live 60 minutes and nothing on this client refreshes them
  // proactively — `onUnauthorized` needs a 401 from some *other* call to fire —
  // so the ordinary "read Monday, sign up Tuesday" path arrives here holding a
  // dead token. Refresh it first, and if that fails send no bearer at all.
  // `onUnauthorized` is the client's existing single-flight refresh; do not add
  // a second one.
  //
  // QUIET: a refresh that fails here must not end the session. The reader is
  // mid sign-up; wiping the guest keys and firing auth-failure (→ signOut) would
  // destroy the very row they are trying to keep, and race the tokens this call
  // is about to write. Send no bearer and let the sign-in proceed.
  if (isTokenExpiring(token)) {
    try {
      token = await (onUnauthorized as QuietRefresh)({ quiet: true })
    } catch {
      token = null
    }
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw Object.assign(new Error(data?.error || `Request failed: ${res.status}`), { status: res.status })
  }
  const data = (await res.json()) as MobileAuthResponse
  return { ...data, sentBearer: !!token }
}

/**
 * Mint an anonymous session so a reader can start before signing up.
 *
 * Deliberately does NOT go through `mobilePost` and sends no `Authorization`:
 * a caller asking for a guest session wants a fresh one, and the server's
 * "you're already authenticated, have your existing user back" branch answers
 * with a token-less `AuthResponse`. Bodyless like `logout` — the handler takes
 * no `[FromBody]` parameter, so there is nothing to serialize.
 *
 * Throws when the body carries no `accessToken`, rather than resolving an
 * object whose fields are `undefined` — a caller would write those straight
 * into SecureStore and only find out on the next request.
 */
export async function createGuestSession(): Promise<MobileAuthResponse> {
  const { baseUrl, headers: base } = getApiConfig()
  const res = await fetch(`${baseUrl}/auth/guest`, {
    method: 'POST',
    headers: { ...base, 'X-Client': 'mobile' },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw Object.assign(new Error(data?.error || `Request failed: ${res.status}`), { status: res.status })
  }
  const data = (await res.json().catch(() => null)) as MobileAuthResponse | null
  if (!data?.accessToken) {
    throw Object.assign(new Error('Guest session response had no accessToken'), { status: res.status })
  }
  return data
}

export async function loginWithGoogle(idToken: string): Promise<MobileAuthResult> {
  return mobilePost('/auth/google', { idToken })
}

export async function loginWithApple(
  identityToken: string,
  fullName?: string | null,
  email?: string | null,
): Promise<MobileAuthResult> {
  return mobilePost('/auth/apple', { identityToken, fullName, email })
}

// Stays on raw `fetch`, without an Authorization header, on purpose. This
// endpoint authenticates with the refresh token in the body; the access token
// it would carry is by definition the expired one we are here to replace, and
// `getAccessToken()` is what a refresh loop is made of. It is also not one of
// the four merge entry points — GetGuestUserId is never consulted here.
export async function refreshTokenMobile(refreshToken: string): Promise<MobileAuthResponse> {
  const { baseUrl, headers: base } = getApiConfig()
  const res = await fetch(`${baseUrl}/auth/refresh-mobile`, {
    method: 'POST',
    headers: { ...base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!res.ok) throw new Error('Token refresh failed')
  return res.json()
}

export async function registerWithEmail(
  email: string,
  password: string,
  name?: string,
): Promise<MobileAuthResult> {
  try {
    return await mobilePost('/auth/register', { email, password, name: name || null })
  } catch (e: any) {
    if (e.status === 409) throw new Error('An account with this email already exists.')
    if (e.status === 400) throw new Error(e.message || 'Invalid email or password.')
    throw new Error('Registration failed')
  }
}

export async function loginWithEmail(
  email: string,
  password: string,
): Promise<MobileAuthResult> {
  try {
    return await mobilePost('/auth/login', { email, password })
  } catch (e: any) {
    if (e.status === 401) throw new Error('Invalid email or password.')
    throw new Error('Login failed')
  }
}

// forgotPassword/resetPassword also stay unauthenticated: neither reaches
// GetGuestUserId, both are reached by people who cannot sign in, and a bearer
// on a password-reset call buys nothing while widening where the token travels.
export async function forgotPassword(email: string): Promise<void> {
  const { baseUrl, headers: base } = getApiConfig()
  await fetch(`${baseUrl}/auth/forgot-password`, {
    method: 'POST',
    headers: { ...base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const { baseUrl, headers: base } = getApiConfig()
  const res = await fetch(`${baseUrl}/auth/reset-password`, {
    method: 'POST',
    headers: { ...base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw Object.assign(new Error(data?.error || 'Reset failed.'), { status: res.status })
  }
}

export async function logout(accessToken: string): Promise<void> {
  const { baseUrl, headers: base } = getApiConfig()
  await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { ...base, Authorization: `Bearer ${accessToken}` },
  })
}

// Profile. `nativeLanguage` is optional: omit it to leave the field untouched
// (the backend treats a missing NativeLanguage as "don't change"), pass a code to
// set it, or '' to clear it. Lets mobile persist the user's native language so it
// follows them across devices (parity with the web reader).
export async function updateProfile(
  name: string | null,
  accessToken: string,
  nativeLanguage?: string | null,
): Promise<AuthResponse> {
  const { baseUrl, headers: base } = getApiConfig()
  const body: { name: string | null; nativeLanguage?: string | null } = { name }
  if (nativeLanguage !== undefined) body.nativeLanguage = nativeLanguage
  const res = await fetch(`${baseUrl}/me/profile`, {
    method: 'PUT',
    headers: { ...base, 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update profile')
  return res.json()
}

// Fetch the current user (incl. nativeLanguage). Lets a client refresh a stale
// cached user — mobile calls this on launch so a native language set on another
// device shows up without re-login.
export async function getProfile(accessToken: string): Promise<AuthResponse> {
  const { baseUrl, headers: base } = getApiConfig()
  const res = await fetch(`${baseUrl}/me/profile`, {
    method: 'GET',
    headers: { ...base, Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error('Failed to fetch profile')
  return res.json()
}

export async function uploadAvatar(imageUri: string, accessToken: string): Promise<AuthResponse> {
  const { baseUrl, headers: base } = getApiConfig()
  const formData = new FormData()
  const filename = imageUri.split('/').pop() || 'avatar.jpg'
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpg'
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg'
  formData.append('file', { uri: imageUri, name: filename, type: mimeType } as any)
  const res = await fetch(`${baseUrl}/me/profile/avatar`, {
    method: 'POST',
    headers: { ...base, Authorization: `Bearer ${accessToken}` },
    body: formData,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    // Attach the HTTP status so callers can render granular copy
    // (413 → "too large", 415 → "wrong format", etc.) instead of a
    // single generic "Upload failed" (B-20). Kept as a property rather
    // than a subclass to avoid breaking existing `catch (e) { e.message }`
    // callers in web + tests.
    const err = new Error(data?.error || 'Upload failed') as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.json()
}

export async function deleteAvatar(accessToken: string): Promise<void> {
  const { baseUrl, headers: base } = getApiConfig()
  const res = await fetch(`${baseUrl}/me/profile/avatar`, {
    method: 'DELETE',
    headers: { ...base, Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error('Failed to delete avatar')
}
