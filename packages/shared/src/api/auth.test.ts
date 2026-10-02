import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getApiConfig, initApi } from './client'
import {
  createGuestSession,
  loginWithApple,
  loginWithEmail,
  loginWithGoogle,
  registerWithEmail,
} from './auth'

const realFetch = globalThis.fetch

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

const authBody = {
  user: { id: 'u1', email: 'a@b.c' },
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
}

let fetchMock: ReturnType<typeof vi.fn>
let refreshMock: ReturnType<typeof vi.fn>

/**
 * A token shaped like ours: three dot-separated base64url segments whose
 * payload carries an `exp`. The signature is garbage on purpose — nothing on
 * the client validates it, and the server is not in this test.
 */
function tokenExpiringIn(seconds: number, sub = 'guest-1'): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return [
    seg({ alg: 'HS256', typ: 'JWT' }),
    seg({ sub, is_guest: true, exp: Math.floor(Date.now() / 1000) + seconds }),
    'not-a-real-signature',
  ].join('.')
}

function setup(
  token: string | null | (() => Promise<string | null>),
  refreshed: string | null = null,
) {
  fetchMock = vi.fn(async () => ok(authBody))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  refreshMock = vi.fn(async () => refreshed)
  initApi({
    baseUrl: 'https://api.test',
    getAccessToken: typeof token === 'function' ? token : async () => token,
    onUnauthorized: refreshMock as unknown as () => Promise<string | null>,
  })
}

/** The four server-side guest→account merge entry points, in one list. */
const MERGE_ENTRY_POINTS: Array<[string, () => Promise<unknown>]> = [
  ['registerWithEmail', () => registerWithEmail('a@b.c', 'pw', 'A')],
  ['loginWithEmail', () => loginWithEmail('a@b.c', 'pw')],
  ['loginWithGoogle', () => loginWithGoogle('id-token')],
  ['loginWithApple', () => loginWithApple('identity-token')],
]

function headersOf(call = 0): Record<string, string> {
  return (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>
}

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

// Each of these four is a guest→account merge entry point on the server
// (register/login/google/apple → GetGuestUserId → MergeGuestAsync). The server
// reads the guest JWT off the Authorization header first and the cookie
// second; mobile has no cookies. If one of these goes red, a mobile guest who
// signs up loses their vocabulary, highlights, bookmarks, notes, reading
// sessions, progress, library and goals. Do not "fix" it by deleting it.
describe('mobile auth sends the guest bearer, or the guest loses all their data on sign-up', () => {
  const cases = MERGE_ENTRY_POINTS

  for (const [name, call] of cases) {
    it(`${name} attaches Authorization when a session token exists`, async () => {
      setup('guest-token')
      await call()
      expect(headersOf().Authorization).toBe('Bearer guest-token')
    })

    it(`${name} omits Authorization entirely when there is no token`, async () => {
      setup(null)
      await call()
      expect('Authorization' in headersOf()).toBe(false)
    })

    it(`${name} still identifies itself as a mobile client`, async () => {
      setup('guest-token')
      await call()
      expect(headersOf()['X-Client']).toBe('mobile')
    })
  }
})

describe('createGuestSession', () => {
  beforeEach(() => setup('stale-token'))

  it('sends no Authorization — the caller asked for a fresh guest', async () => {
    await createGuestSession()
    expect('Authorization' in headersOf()).toBe(false)
    expect(headersOf()['X-Client']).toBe('mobile')
  })

  it('throws when the body carries no accessToken', async () => {
    // The server answers a POST /auth/guest from an already-authenticated
    // caller with a token-less AuthResponse. Returning it would put
    // `undefined` in SecureStore.
    fetchMock.mockResolvedValueOnce(ok({ user: { id: 'u1' } }))
    await expect(createGuestSession()).rejects.toThrow(/accessToken/)
  })

  it('returns the tokens when the server sends them', async () => {
    await expect(createGuestSession()).resolves.toMatchObject({ accessToken: 'new-access' })
  })
})

// D1. The headline regression: a returning guest who signs up loses everything,
// and the server says 200 while it happens.
//
// Access tokens live 60 minutes; a guest's refresh token lives 30 days. Nothing
// on this client refreshes proactively — `onUnauthorized` only fires on a 401
// from some OTHER call — so "read on Monday, tap Create free account on
// Tuesday" arrives at `/auth/register` holding a token that died overnight.
// `GetGuestUserId` validates it with `ClockSkew = Zero`, gets null, skips
// `MergeGuestAsync`, and registration still answers 200. QA reproduced it with
// a forged token differing only in `exp`:
//
//   register with EXPIRED guest token -> 200 | promoted in place? False
//   register with VALID   guest token -> 200 | promoted in place? True
//
// So the rule is: a valid bearer, or none. Never an expired one — none at least
// cannot masquerade as a live guest.
describe('an expired guest bearer is refreshed before the merge, or dropped', () => {
  for (const [name, call] of MERGE_ENTRY_POINTS) {
    it(`${name} refreshes an expired token and sends the fresh one`, async () => {
      setup(tokenExpiringIn(-3600), 'fresh-token')
      await call()
      expect(refreshMock).toHaveBeenCalledTimes(1)
      expect(headersOf().Authorization).toBe('Bearer fresh-token')
    })

    it(`${name} sends NO bearer when the refresh fails, rather than a dead one`, async () => {
      // Offline, or the refresh token is gone. A dead bearer would be accepted
      // with a 200 and silently drop the merge; no bearer at least lets the
      // server see there is no guest.
      setup(tokenExpiringIn(-3600), null)
      await call()
      expect('Authorization' in headersOf()).toBe(false)
    })

    it(`${name} does not refresh a token that is still good`, async () => {
      setup(tokenExpiringIn(3600), 'fresh-token')
      await call()
      expect(refreshMock).not.toHaveBeenCalled()
      expect(headersOf().Authorization).toBe(`Bearer ${await getApiConfig().getAccessToken()}`)
    })
  }

  it('refreshes a token that is valid now but expires mid-flight', async () => {
    // 10s of life left. The request has to reach the server, be validated, and
    // run the merge; a token that dies on the way is the same silent 200.
    setup(tokenExpiringIn(10), 'fresh-token')
    await registerWithEmail('a@b.c', 'pw')
    expect(headersOf().Authorization).toBe('Bearer fresh-token')
  })

  it('leaves an unparseable token alone instead of gambling a refresh on it', async () => {
    // We cannot read `exp`, so we do not know it is dead. Refreshing on a guess
    // risks losing a perfectly valid bearer when the refresh fails offline.
    setup('not-a-jwt')
    await registerWithEmail('a@b.c', 'pw')
    expect(refreshMock).not.toHaveBeenCalled()
    expect(headersOf().Authorization).toBe('Bearer not-a-jwt')
  })

  it('sends no bearer, and does not refresh, when there is no session at all', async () => {
    setup(null)
    await registerWithEmail('a@b.c', 'pw')
    expect(refreshMock).not.toHaveBeenCalled()
    expect('Authorization' in headersOf()).toBe(false)
  })
})

// F9. `mobilePost` started awaiting `getAccessToken()`, and these two endpoints
// had never touched storage before. A rejecting SecureStore — locked device,
// corrupted keychain entry, missing native module — must not become "you cannot
// sign in". No token is a fully supported state.
describe('a keychain that throws does not break sign-in', () => {
  for (const [name, call] of MERGE_ENTRY_POINTS) {
    it(`${name} still succeeds when getAccessToken() rejects`, async () => {
      setup(async () => { throw new Error('SecureStore unavailable') })
      await expect(call()).resolves.toMatchObject({ accessToken: 'new-access' })
      expect('Authorization' in headersOf()).toBe(false)
    })
  }

  it('still succeeds when the refresh itself rejects', async () => {
    setup(tokenExpiringIn(-3600))
    refreshMock.mockRejectedValueOnce(new Error('refresh blew up'))
    await expect(registerWithEmail('a@b.c', 'pw')).resolves.toMatchObject({ accessToken: 'new-access' })
    expect('Authorization' in headersOf()).toBe(false)
  })
})

// The login screen claims "your progress moved to your account" only when a
// bearer actually went out AND the server reported no skip. `guestMergeSkipped`
// is null both for a clean merge and for "there was no token to merge from", so
// `sentBearer` is the half the response cannot supply.
describe('sentBearer reports whether a bearer went out with the call', () => {
  for (const [name, call] of MERGE_ENTRY_POINTS) {
    it(`${name}: true with a session token`, async () => {
      setup('guest-token')
      await expect(call()).resolves.toMatchObject({ sentBearer: true, accessToken: 'new-access' })
    })

    it(`${name}: false with no token`, async () => {
      setup(null)
      await expect(call()).resolves.toMatchObject({ sentBearer: false })
    })

    it(`${name}: false when an expired token could not be refreshed`, async () => {
      setup(tokenExpiringIn(-3600), null)
      await expect(call()).resolves.toMatchObject({ sentBearer: false })
    })
  }
})

// A refresh that fails inside a sign-up must not end the session it is trying
// to keep: mobile's `onUnauthorized` wipes the stored tokens and fires
// auth-failure (→ signOut) on a rejected refresh unless asked to be quiet.
describe('the pre-merge refresh is quiet', () => {
  for (const [name, call] of MERGE_ENTRY_POINTS) {
    it(`${name} asks onUnauthorized for a quiet refresh`, async () => {
      setup(tokenExpiringIn(-3600), 'fresh-token')
      await call()
      expect(refreshMock).toHaveBeenCalledWith({ quiet: true })
    })
  }
})
