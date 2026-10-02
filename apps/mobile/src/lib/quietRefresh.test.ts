import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// api.ts picks localStorage over SecureStore on web — the only branch Node can run.
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})

const { onUnauthorized, resetAuthFailureLatch } = await import('./api')
const { onAuthFailure } = await import('./authEvents')

const realFetch = globalThis.fetch
let failures = 0
let unsub: () => void

beforeEach(() => {
  store.clear()
  store.set('access_token', 'guest-access')
  store.set('refresh_token', 'guest-refresh')
  resetAuthFailureLatch()
  failures = 0
  unsub = onAuthFailure(() => { failures++ })
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
})

afterEach(() => {
  unsub()
  globalThis.fetch = realFetch
})

/**
 * A refresh rejected by the server ends the session — except inside a sign-in.
 * There the reader is turning this guest INTO an account: wiping its keys and
 * firing auth-failure (→ signOut) mid-register used to throw the guest away and
 * race the new tokens. `authApi`'s pre-merge refresh asks for `{ quiet: true }`.
 */
describe('onUnauthorized', () => {
  it('a normal rejected refresh wipes the tokens and fires auth-failure', async () => {
    await expect(onUnauthorized()).resolves.toBeNull()
    expect(store.has('access_token')).toBe(false)
    expect(store.has('refresh_token')).toBe(false)
    expect(failures).toBe(1)
  })

  it('a quiet rejected refresh keeps the guest keys and stays silent', async () => {
    await expect(onUnauthorized({ quiet: true })).resolves.toBeNull()
    expect(store.get('access_token')).toBe('guest-access')
    expect(store.get('refresh_token')).toBe('guest-refresh')
    expect(failures).toBe(0)
  })

  it('a quiet refresh with no refresh token is silent too', async () => {
    store.delete('refresh_token')
    await expect(onUnauthorized({ quiet: true })).resolves.toBeNull()
    expect(store.get('access_token')).toBe('guest-access')
    expect(failures).toBe(0)
  })
})
