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
})
