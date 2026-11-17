import { describe, it, expect, vi, afterEach } from 'vitest'

// No fake-indexeddb in the repo: a minimal stub drives onupgradeneeded with a v9-shaped DB.
function stubIndexedDb(existingStores: string[]) {
  const stores = new Set(existingStores)
  const names = { contains: (n: string) => stores.has(n) }
  const db = {
    objectStoreNames: names,
    createObjectStore: vi.fn((n: string) => {
      stores.add(n)
      return { createIndex: vi.fn() }
    }),
    deleteObjectStore: vi.fn((n: string) => stores.delete(n)),
  }
  const transaction = { objectStore: () => ({ indexNames: { contains: () => true }, createIndex: vi.fn() }) }
  const open = vi.fn(() => {
    const request: Record<string, unknown> = { result: db, transaction }
    queueMicrotask(() => {
      ;(request.onupgradeneeded as (e: unknown) => void)({ target: request })
      ;(request.onsuccess as () => void)()
    })
    return request
  })
  vi.stubGlobal('indexedDB', { open })
  return { db, stores, open }
}

describe('openOfflineDb upgrade', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('v11 drops the retired dictionary and catalog stores and leaves the others alone', async () => {
    const v9 = ['bookmarks', 'chapters', 'cachedBooks', 'highlights', 'translations', 'dictionary', 'tts-audio', 'pendingVocabWords', 'explains']
    const { db, stores, open } = stubIndexedDb(v9)
    const { openOfflineDb } = await import('./offlineDb')

    await openOfflineDb()

    const retired = ['chapters', 'cachedBooks', 'dictionary']
    expect(open).toHaveBeenCalledWith('textstack-reader', 11)
    expect(db.deleteObjectStore.mock.calls.map(([n]) => n).sort()).toEqual(retired.sort())
    expect(db.createObjectStore).not.toHaveBeenCalled()
    expect([...stores]).toEqual(v9.filter((s) => !retired.includes(s)))
  })
})
