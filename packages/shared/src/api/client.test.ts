import { describe, it, expect, afterEach, vi } from 'vitest'
import { authFetch, initApi, publicFetch } from './client'
import { createGuestSession } from './auth'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const res = (status: number, body = '{}') => new Response(body, { status })

describe('authFetch cookie mode (web)', () => {
  it('sends credentials, no Bearer; on 401 refreshes then retries with the cookie alone', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200, '{"ok":true}'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const refresh = vi.fn().mockResolvedValue('')
    initApi({ baseUrl: 'http://api', getAccessToken: async () => null, onUnauthorized: refresh, credentials: 'include' })

    await expect(authFetch('/me/x')).resolves.toEqual({ ok: true })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.credentials).toBe('include')
      expect(init.headers.Authorization).toBeUndefined()
    }
  })

  it('refresh failed (null) → 401, no retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(401))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    initApi({ baseUrl: 'http://api', getAccessToken: async () => null, onUnauthorized: async () => null, credentials: 'include' })

    await expect(authFetch('/me/x')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('authFetch bearer mode (mobile) is unchanged', () => {
  it('no credentials key; empty refresh result does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(401))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => '' })

    await expect(authFetch('/me/x')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1]
    expect('credentials' in init).toBe(false)
    expect(init.headers.Authorization).toBe('Bearer t')
  })
})

describe('config headers (mobile X-App-Version, review #23)', () => {
  const headers = { 'X-App-Version': '1.2.3', 'X-App-Build': '42' }

  it('go out on authFetch, publicFetch and the raw auth fetches; per-call headers still win', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => res(200, '{"accessToken":"a"}'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null, headers })

    await authFetch('/me/x', { headers: { 'Content-Type': 'application/json' } })
    await publicFetch('/app/config')
    await createGuestSession()

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers['X-App-Version']).toBe('1.2.3')
      expect(init.headers['X-App-Build']).toBe('42')
    }
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json')
    expect(fetchMock.mock.calls[2][1].headers['X-Client']).toBe('mobile')
  })

  it('none configured (web) → no app headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    initApi({ baseUrl: 'http://api', getAccessToken: async () => null, onUnauthorized: async () => null, credentials: 'include' })

    await publicFetch('/books')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({})
  })
})
