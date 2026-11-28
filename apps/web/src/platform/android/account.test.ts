import { beforeEach, describe, expect, it, vi } from 'vitest'

// Secure storage as a memory map; the device library and the sync as spies that log their order.
const secure = new Map<string, string>()
const steps: string[] = []
let ownedLoss: { loss: unknown; email: string | null } | null = null

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    getItem: async (k: string) => secure.get(k) ?? null,
    setItem: async (k: string, v: string) => { secure.set(k, v) },
    removeItem: async (k: string) => { secure.delete(k) },
  },
}))
vi.mock('./librarySync', () => ({
  claimLibraryFor: async (id: string) => { steps.push(`claim ${id}`) },
  adoptLocalAccount: async (from: string, to: string) => { steps.push(`adopt ${from}→${to}`) },
  pushBeforeSignOut: async (id: string) => { steps.push(`push ${id}`) },
}))
vi.mock('./deviceLibrary', () => ({
  LIBRARY_WIPE_MS: 5000,
  clearWipePending: async () => {},
  rememberOwnerEmail: async () => {},
  deviceOwnedLoss: async () => ownedLoss,
  wipeDeviceLibrary: async () => { steps.push(`wipe (tokens ${secure.has('access_token') ? 'kept' : 'gone'})`) },
}))

const { account } = await import('./account')
const { setupApi, cachedAccessToken } = await import('./api')

const user = (id: string, isGuest = false) => ({ id, email: isGuest ? '' : `${id}@example.com`, name: null, picture: null, isGuest, createdAt: '2026-11-27T00:00:00Z', nativeLanguage: null })
const session = (id: string, isGuest = false) => ({ accessToken: `at-${id}`, refreshToken: `rt-${id}`, user: user(id, isGuest) })

/** The server: each route answers from `routes`; every call is logged as "METHOD path". */
let calls: string[] = []
function server(routes: Record<string, () => Response>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname
    calls.push(`${init.method ?? 'GET'} ${path}`)
    const answer = routes[path]
    if (!answer) throw new TypeError('Failed to fetch')
    return answer()
  }))
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })

describe('the Android account (bearer session, device library claim)', () => {
  beforeEach(() => {
    secure.clear()
    steps.length = 0
    ownedLoss = null
    setupApi()
  })

  it('loginWithEmail_AfterAGuest_TokensStoredLibraryClaimedThenAdoptedBeforeItAnswers', async () => {
    server({ '/auth/guest': ok(session('g1', true)), '/auth/login': ok({ ...session('u1'), merge: { books: {}, files: {} } }) })
    await account.createGuestSession()
    const res = await account.loginWithEmail('u1@example.com', 'pw')
    expect(res.user.id).toBe('u1')
    expect(secure.get('access_token')).toBe('at-u1')
    expect(JSON.parse(secure.get('user')!).id).toBe('u1')
    expect(cachedAccessToken()).toBe('at-u1')
    expect(steps).toEqual(['claim g1', 'claim u1', 'adopt g1→u1'])
  })

  it('createGuestSession_DeviceHoldsAnotherAccountsUnsyncedBooks_NoMintNoServerCall', async () => {
    server({ '/auth/guest': ok(session('g1', true)) })
    ownedLoss = { loss: { books: 1, writes: 0 }, email: 'a@example.com' }
    await expect(account.createGuestSession()).rejects.toThrow(/another account/)
    expect(calls).toEqual([])
    expect(secure.size).toBe(0)
  })

  it('getCurrentUser_Offline_TheStoredUserWithNoNetwork', async () => {
    server({ '/auth/login': ok(session('u1')) })
    await account.loginWithEmail('u1@example.com', 'pw')
    server({}) // offline: every call fails
    expect((await account.getCurrentUser()).user.id).toBe('u1')
    expect(calls).toEqual([])
  })

  it('getCurrentUser_NoSession_Rejects401', async () => {
    await expect(account.getCurrentUser()).rejects.toMatchObject({ status: 401 })
  })

  it('logout_PushesFirstThenTheServerThenTokensGoneBeforeTheWipe', async () => {
    server({ '/auth/login': ok(session('u1')), '/auth/logout': () => new Response(null, { status: 204 }) })
    await account.loginWithEmail('u1@example.com', 'pw')
    steps.length = 0
    calls = []
    await account.logout()
    expect(steps).toEqual(['push u1', 'wipe (tokens gone)'])
    expect(calls).toEqual(['POST /auth/logout'])
    expect(secure.size).toBe(0)
    expect(cachedAccessToken()).toBeNull()
  })

  it('logout_Offline_TheSessionStillEndsHere', async () => {
    server({ '/auth/login': ok(session('u1')) })
    await account.loginWithEmail('u1@example.com', 'pw')
    server({})
    await account.logout()
    expect(secure.size).toBe(0)
    expect(steps.slice(-1)[0]).toBe('wipe (tokens gone)')
  })
})
