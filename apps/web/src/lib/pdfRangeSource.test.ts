import { afterEach, describe, it, expect, vi } from 'vitest'
import { openPdfSource } from './pdfRangeSource'

// The range logic is tested in packages/shared (pdfRangeSource.test.ts); web binds the cookie.
afterEach(() => vi.unstubAllGlobals())

describe('openPdfSource (web)', () => {
  it('openPdfSource_Web_EveryRequestSendsTheCookie', async () => {
    const fetch = vi.fn(async (..._a: unknown[]) => new Response(new Uint8Array(4), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await openPdfSource('/me/books/b1/file', { refresh: vi.fn() })
    expect(fetch).toHaveBeenCalledWith('/me/books/b1/file', expect.objectContaining({ credentials: 'include' }))
  })

  it('openPdfSource_Web403_IsALoadErrorNotTheSessionBanner', async () => {
    // The API answers a missing session with 401; a 403 is no access to this file, which a refresh can't fix.
    vi.stubGlobal('fetch', vi.fn(async (..._a: unknown[]) => new Response(null, { status: 403 })))
    const refresh = vi.fn()
    const err = await openPdfSource('/me/books/b1/file', { refresh }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toEqual({ code: 'pdf-auth' })
    expect(refresh).not.toHaveBeenCalled()
  })
})
