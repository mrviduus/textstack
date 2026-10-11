import { describe, it, expect, vi, afterEach } from 'vitest'

// Map-backed IndexedDB stub: open → onsuccess, get/put by keyPath 'key'.
function stubStore() {
  const rows = new Map<string, Record<string, unknown>>()
  const req = (fn: () => unknown) => {
    const r: Record<string, unknown> = {}
    queueMicrotask(() => { r.result = fn(); (r.onsuccess as () => void)() })
    return r
  }
  const store = {
    get: (k: string) => req(() => rows.get(k)),
    put: (v: Record<string, unknown>) => req(() => { rows.set(v.key as string, v) }),
  }
  const db = { transaction: () => ({ objectStore: () => store }) }
  vi.stubGlobal('indexedDB', { open: () => req(() => db) })
  return rows
}

describe('TR-1: web translation cache key', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('TR-1: the IndexedDB key is a compact hash, and a read verifies the full key on the row', async () => {
    const rows = stubStore()
    const { cacheTranslation, getCachedTranslation } = await import('./offlineDb')
    const sentence = 'A long sentence. '.repeat(60)

    await cacheTranslation('en', 'pt', 'Aa', 'um', { sentence, bookId: 'b1' })

    const [key] = [...rows.keys()]
    expect(key.length).toBeLessThan(40)
    // 'Aa' and 'BB' share a 31-polynomial hash: the full-key check must refuse the impostor.
    expect(await getCachedTranslation('en', 'pt', 'BB', { sentence, bookId: 'b1' })).toBeNull()
    expect((await getCachedTranslation('en', 'pt', 'Aa', { sentence, bookId: 'b1' }))?.translatedText).toBe('um')
  })
})
