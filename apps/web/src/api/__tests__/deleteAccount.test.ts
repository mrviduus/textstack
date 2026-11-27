import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deleteAccount } from '../auth'

describe('deleteAccount', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('DELETEs /me/account with credentials and resolves on 204', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteAccount()).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/me/account')
    expect(opts.method).toBe('DELETE')
    expect(opts.credentials).toBe('include')

    vi.unstubAllGlobals()
  })

  it('rejects on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'boom' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteAccount()).rejects.toThrow('boom')

    vi.unstubAllGlobals()
  })
})
