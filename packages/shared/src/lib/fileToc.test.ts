import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from '../api/client'
import { syncTocIfMissing, tocForServer, type FileTocEntry } from './fileToc'

const API = 'http://api'
const entry = (key: string, depth: number, title = key): FileTocEntry => ({ key, title, depth, fraction: 0.5 })
const bytes = (toc: unknown) => new TextEncoder().encode(JSON.stringify(toc)).length

// ADR-033 P3: a huge contents list still reaches the server, its outline kept and its finest detail given up.
describe('fitting a TOC to the server', () => {
  it('aTocOverTheCap_LosesItsDeepestLevelFirst_ThenTheNext', () => {
    const toc = [entry('toc-0', 0), entry('toc-1', 1), entry('toc-2', 2), entry('toc-3', 2), entry('toc-4', 0)]
    const keys = (cap: number) => tocForServer(toc, cap).map((e) => e.key)
    expect(keys(bytes(toc))).toEqual(['toc-0', 'toc-1', 'toc-2', 'toc-3', 'toc-4'])
    expect(keys(bytes(toc) - 1)).toEqual(['toc-0', 'toc-1', 'toc-4'])
    expect(keys(bytes([toc[0], toc[1], toc[4]]) - 1)).toEqual(['toc-0', 'toc-4'])
  })

  it('fiveThousandTopLevelChapters_AreCutAtTheEnd_UnderTheCap', () => {
    const toc = Array.from({ length: 5000 }, (_, i) => entry(`toc-${i}`, 0, 'Ж'.repeat(60)))
    const fitted = tocForServer(toc)
    expect(bytes(fitted)).toBeLessThanOrEqual(256 * 1024)
    expect(fitted).toEqual(toc.slice(0, fitted.length))
    expect(bytes(toc.slice(0, fitted.length + 1))).toBeGreaterThan(256 * 1024)
  })

  it('whatTheServerRefuses_IsLeftOut', () => {
    expect(tocForServer([
      entry('toc-0', 9), { key: 'toc-0', title: 'twin', depth: 0, fraction: 0 }, { key: '', title: 'x', depth: 0, fraction: 0 },
      { key: 'toc-2', title: '  ', depth: 0, fraction: 0 }, { key: 'toc-3', title: 'x', depth: 0, fraction: 1.5 }, null,
    ])).toEqual([entry('toc-0', 6)])
    expect(tocForServer('nope')).toEqual([])
  })
})

/** The server: every PUT 204, or `fail` thrown. */
function server(fail?: Error) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url.replace(/^.*\/files\/f1/, '')}`)
    if (fail) throw fail
    return { ok: true, status: 204, text: async () => '' }
  }))
  return calls
}

describe('sending a TOC after an open', () => {
  beforeEach(() => initApi({ baseUrl: API, getAccessToken: async () => 't', onUnauthorized: async () => null }))
  afterEach(() => vi.unstubAllGlobals())
  const page = async () => [entry('toc-0', 0)]

  it('aFileWithNoServerToc_GetsItOnce_OneWithIt_Nothing', async () => {
    const calls = server()
    const toc = vi.fn(page)
    expect(await syncTocIfMissing('b1', 'f1', toc, false)).toBe(true)
    expect(await syncTocIfMissing('b1', 'f1', toc, true)).toBe(false)
    expect(await syncTocIfMissing('b1', 'f1', toc, undefined)).toBe(false)
    expect(toc).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['PUT /toc'])
  })

  it('anOfflineOrFailingServer_IsSwallowed', async () => {
    server(new TypeError('Failed to fetch'))
    await expect(syncTocIfMissing('b1', 'f1', page, false)).resolves.toBe(false)
  })
})
