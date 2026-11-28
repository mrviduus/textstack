import { afterAll, describe, expect, it, vi } from 'vitest'

const secure = new Map<string, string>()
// Capacitor plugins are proxies whose `then` is a native method: a promise resolved with one throws.
const plugin = <T extends object>(name: string, methods: T) =>
  new Proxy(methods, { get: (t, k) => { if (k === 'then') throw new Error(`"${name}.then()" is not implemented on web`); return t[k as keyof T] } })
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: plugin('SecureStorage', {
    getItem: async (k: string) => secure.get(k) ?? null,
    setItem: async (k: string, v: string) => { secure.set(k, v) },
    removeItem: async (k: string) => { secure.delete(k) },
  }),
}))
vi.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: plugin('SocialLogin', {
    initialize: async () => {},
    login: vi.fn(async () => ({ provider: 'google', result: { idToken: 'google-id-token' } })),
    logout: async () => {},
  }),
}))
vi.mock('./android/librarySync', () => ({ claimLibraryFor: async () => {}, adoptLocalAccount: async () => {}, pushBeforeSignOut: async () => {} }))
vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'web-client-id')

const { platform } = await import('./android')
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('the Android platform (session members)', () => {
  it('fetchInit_BeforeAndAfterASignIn_NeverThrowsThenCarriesTheBearer', async () => {
    expect(platform.transport.fetchInit()).toEqual({ headers: {} })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      accessToken: 'at-u1', refreshToken: 'rt-u1',
      user: { id: 'u1', email: 'u1@example.com', name: null, picture: null, isGuest: false, createdAt: '2026-11-27T00:00:00Z', nativeLanguage: null },
    }), { status: 200 })))
    await platform.account.loginWithEmail('u1@example.com', 'pw')
    expect(platform.transport.fetchInit()).toEqual({ headers: { Authorization: 'Bearer at-u1' } })
  })

  it('google_ButtonTapped_TheIdTokenGoesToTheCallback', async () => {
    const onIdToken = vi.fn()
    expect(await platform.google.init(onIdToken)).toBe(true)
    const el = document.createElement('div')
    platform.google.renderButton(el)
    platform.google.renderButton(el)
    expect(el.querySelectorAll('button')).toHaveLength(1)
    el.querySelector('button')!.click()
    el.querySelector('button')!.click()
    await vi.waitFor(() => expect(onIdToken).toHaveBeenCalledWith('google-id-token'))
    expect(onIdToken).toHaveBeenCalledTimes(1)
  })
})
