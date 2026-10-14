import { describe, it, expect, vi } from 'vitest'
import { openPdfSource } from './pdfRangeSource'

// Phase 5 slice 3 (answer 4a): web hands the engine `read()`; the host owns the cookie and the 401.

const FILE = new Uint8Array(Array.from({ length: 100 }, (_, i) => i))

/** A server answering ranges of FILE; the next `deny` requests get a 401. */
function server(opts: { ranges?: boolean } = {}) {
  const s = {
    deny: 0,
    calls: [] as { range: string | null; credentials?: RequestCredentials }[],
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range')
      s.calls.push({ range, credentials: init?.credentials })
      if (s.deny > 0) { s.deny--; return new Response(null, { status: 401 }) }
      if (opts.ranges === false || !range) return new Response(FILE.slice(), { status: 200 })
      const [a, b] = range.replace('bytes=', '').split('-').map(Number)
      return new Response(FILE.slice(a, b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${FILE.length}` } })
    }),
  }
  return s
}
const asFetch = (f: unknown) => f as typeof globalThis.fetch

async function ranges(s: ReturnType<typeof server>, refresh = vi.fn(async () => {})) {
  const src = await openPdfSource('/me/books/b1/file', { fetch: asFetch(s.fetch), refresh })
  if (!('read' in src)) throw new Error('expected a range source')
  return src
}

describe('openPdfSource', () => {
  it('openPdfSource_RangeServer_LengthFromProbeAndReadsByRangeWithTheCookie', async () => {
    const s = server()
    const src = await ranges(s)
    expect(src.length).toBe(100)
    expect(Array.from(await src.read(10, 14))).toEqual([10, 11, 12, 13])
    expect(s.calls.map((c) => c.range)).toEqual(['bytes=0-0', 'bytes=10-13'])
    expect(s.calls.every((c) => c.credentials === 'include')).toBe(true)
  })

  it('openPdfSource_ServerIgnoresRange_WholeFileAsData', async () => {
    const src = await openPdfSource('/f', { fetch: asFetch(server({ ranges: false }).fetch), refresh: vi.fn() })
    expect('data' in src && new Uint8Array(src.data).length).toBe(100)
  })

  it('openPdfSource_Probe401_RefreshesAndRetriesOnce', async () => {
    const s = server()
    s.deny = 1
    const refresh = vi.fn(async () => {})
    expect((await ranges(s, refresh)).length).toBe(100)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('openPdfSource_Read401_RefreshesAndRetriesInsideRead', async () => {
    const s = server()
    const refresh = vi.fn(async () => {})
    const src = await ranges(s, refresh)
    s.deny = 1   // the session expired mid-book
    expect(Array.from(await src.read(0, 2))).toEqual([0, 1])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('openPdfSource_ReadStill401AfterRefresh_RejectsPdfAuth', async () => {
    const s = server()
    const refresh = vi.fn(async () => {})
    const src = await ranges(s, refresh)
    s.deny = 2
    await expect(src.read(0, 4)).rejects.toEqual({ code: 'pdf-auth' })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('openPdfSource_RefreshFails_RejectsPdfAuth', async () => {
    const s = server()
    s.deny = 1
    await expect(ranges(s, vi.fn(async () => { throw new Error('no session') }))).rejects.toEqual({ code: 'pdf-auth' })
  })

  it('openPdfSource_LaterReadAnswers200_RejectsInsteadOfHandingInTheWholeFile', async () => {
    const s = server()
    const src = await ranges(s)
    s.fetch.mockImplementationOnce(async () => new Response(FILE.slice(), { status: 200 }))
    await expect(src.read(10, 14)).rejects.toBeInstanceOf(Error)
  })

  it('openPdfSource_ServerError_RejectsAnErrorNotPdfAuth', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(openPdfSource('/f', { fetch: asFetch(fetch), refresh: vi.fn() })).rejects.toBeInstanceOf(Error)
  })
})
