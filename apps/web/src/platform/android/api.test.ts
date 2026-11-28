import { beforeEach, describe, expect, it, vi } from 'vitest'

const secure = new Map<string, string>()
// A Capacitor plugin is a proxy whose every property is a native method, `then` too: a promise resolved with it throws.
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: new Proxy({
    getItem: async (k: string) => secure.get(k) ?? null,
    setItem: async (k: string, v: string) => { secure.set(k, v) },
    removeItem: async (k: string) => { secure.delete(k) },
  }, { get: (t, k) => { if (k === 'then') throw new Error('"SecureStorage.then()" is not implemented on web'); return t[k as keyof typeof t] } }),
}))

const { onUnauthorized, freshAccessToken, resetAuthFailureLatch, cachedAccessToken } = await import('./api')
const { onAuthFailure } = await import('./authEvents')

/** A JWT whose `exp` is `inSeconds` from now (isTokenExpiring reads only that). */
const jwt = (inSeconds: number) => `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + inSeconds }))}.y`

let refreshes = 0
function refreshAnswers(answer: () => Response | Promise<Response>) {
  refreshes = 0
  vi.stubGlobal('fetch', vi.fn(async () => { refreshes++; return answer() }))
}

describe('the Android bearer refresh (copy of the Expo api.ts)', () => {
  beforeEach(() => {
    secure.clear()
    secure.set('access_token', 'old')
    secure.set('refresh_token', 'rt')
    resetAuthFailureLatch()
  })

  it('onUnauthorized_ConcurrentCalls_OneRefreshTheNewTokensKept', async () => {
    refreshAnswers(() => new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'rt2' }), { status: 200 }))
    const [a, b] = await Promise.all([onUnauthorized(), onUnauthorized()])
    expect([a, b]).toEqual(['new', 'new'])
    expect(refreshes).toBe(1)
    expect(secure.get('refresh_token')).toBe('rt2')
    expect(cachedAccessToken()).toBe('new')
  })

  it('onUnauthorized_Offline_TokensKeptNoFailureEmitted', async () => {
    refreshAnswers(() => { throw new TypeError('Failed to fetch') })
    const failures = vi.fn()
    const off = onAuthFailure(failures)
    expect(await onUnauthorized()).toBeNull()
    expect(secure.get('refresh_token')).toBe('rt')
    expect(failures).not.toHaveBeenCalled()
    off()
  })

  it('onUnauthorized_ServerRejects_TokensClearedFailureEmittedOnce', async () => {
    refreshAnswers(() => new Response(null, { status: 401 }))
    const failures = vi.fn()
    const off = onAuthFailure(failures)
    await onUnauthorized()
    secure.set('refresh_token', 'rt')
    await onUnauthorized()
    expect(secure.has('access_token')).toBe(false)
    expect(failures).toHaveBeenCalledTimes(1)
    off()
  })

  it('freshAccessToken_TokenCloseToExpiry_RefreshedFirst', async () => {
    secure.set('access_token', jwt(10))
    refreshAnswers(() => new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'rt2' }), { status: 200 }))
    expect(await freshAccessToken()).toBe('new')
    secure.set('access_token', jwt(3600))
    expect(await freshAccessToken()).toBe(secure.get('access_token'))
    expect(refreshes).toBe(1)
  })
})
