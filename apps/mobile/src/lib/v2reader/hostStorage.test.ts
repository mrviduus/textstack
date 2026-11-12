import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { isUuid } from '@textstack/shared'
import { createV2Storage, nonceFromUuid, readRecovering, sha256Key, type V2Files } from './hostStorage'
import { createLocalLibrary } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { v2ReaderPageHtml } from './v2ReaderPage.generated'

const CFI = 'epubcfi(/6/14!/4/2/1:0)'
const pos = { cfi: CFI, quote: 'It was a bright cold day', index: 6, fraction: 0.41, at: 1000 }
const entry = (e: { position: unknown; highlights: unknown[] }) => JSON.stringify({ v: 1, book: { sha256: 'ab'.repeat(32), size: 10, name: 'b.epub' }, ...e })

/** In-memory files that log every operation and yield between steps, as the native calls do. */
function memoryFiles() {
  const data = new Map<string, string>()
  const ops: string[] = []
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const files: V2Files = {
    async read(name) { await tick(); return data.get(name) ?? null },
    async move(from, to) {
      ops.push(`move ${from} ${to}`)
      await tick()
      const text = data.get(from)
      if (text === undefined) throw new Error(`no ${from}`)
      data.set(to, text)
      data.delete(from)
    },
    exists: (name) => data.has(name),
    remove: (name) => { ops.push(`remove ${name}`); data.delete(name) },
    async copyIn(uri, to) {
      ops.push(`copyIn ${uri} ${to}`)
      // A full disk: the copy dies part-way, its partial file left behind (as Android's copy does).
      data.set(to, uri.endsWith('full') ? 'partial' : `bytes of ${uri}`)
      await tick()
      if (uri.endsWith('full')) throw new Error('ENOSPC (No space left on device)')
    },
  }
  return { files, data, ops }
}

const SHA_A = 'AB'.repeat(32)
const SHA_A_KEY = SHA_A.toLowerCase()
const SHA_B = 'cd'.repeat(32)
const book = (sha256: string) => ({ sha256, size: 10, title: 'T', author: '', originalName: 'b.epub' })

describe('v2 host storage', () => {
  it('readRecovering_TargetMissing_ReadsTheTmp_TargetPresent_TargetWins', async () => {
    const { files, data } = memoryFiles()
    data.set('store/x.json.tmp', 'new')
    expect(await readRecovering(files, 'store/x.json')).toBe('new')
    data.set('store/x.json', 'old')
    // Even a complete tmp loses to an existing target: a save killed before its move is lost.
    expect(await readRecovering(files, 'store/x.json')).toBe('old')
    // With a check (#1081): a target that fails it is passed over for the tmp; neither passing is null.
    expect(await readRecovering(files, 'store/x.json', (t) => t === 'new')).toBe('new')
    expect(await readRecovering(files, 'store/x.json', () => false)).toBeNull()
  })

  const storage = (m = memoryFiles(), newId: () => string = randomUUID) => {
    const lib = createLocalLibrary(memoryDb())
    return { ...m, lib, storage: createV2Storage(m.files, newId, lib) }
  }

  it('addOpened_TwoConcurrentImports_BothLand', async () => {
    const { storage: s } = storage()
    await Promise.all([s.addOpened(book(SHA_A), null), s.addOpened(book(SHA_B), null)])
    expect((await s.books()).map((b) => b.sha256)).toEqual([SHA_A_KEY, SHA_B])
  })

  it('addOpened_NewBook_IdFromTheGivenNewId_UuidBookAndFile', async () => {
    const ids = [randomUUID(), randomUUID()]
    const { storage: s, lib } = storage(memoryFiles(), () => ids.shift()!)
    const [bookId, fileId] = ids
    const { books, bookId: opened } = await s.addOpened({ ...book(SHA_B), format: 'mobi' }, null)
    expect(books.map((b) => b.id)).toEqual([bookId])
    expect(opened).toBe(bookId)
    expect(await lib.book(bookId)).toMatchObject({ file_id: fileId, format: 'mobi', sha256: SHA_B })
    expect(await lib.outbox()).toEqual([{ kind: 'book', target: bookId, gen: 1, failures: 0 }])
  })

  it('addOpened_SameBytesInUpperCase_ExistingEntryAndStagedCopyDropped', async () => {
    const { storage: s, data } = storage()
    data.set('staging/1.epub', 'bytes')
    await s.addOpened(book(SHA_A_KEY), 'staging/1.epub')
    data.set('staging/2.epub', 'bytes')
    const { books } = await s.addOpened(book(SHA_A), 'staging/2.epub')
    expect(books).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${SHA_A_KEY}.epub`])
  })

  it('addOpened_BytesAlreadyRetained_AdoptsTheFileAndDropsTheStagedCopy', async () => {
    const m = memoryFiles()
    m.data.set(`books/${SHA_A_KEY}.epub`, 'retained')
    m.data.set('staging/1.epub', 'staged')
    const { storage: s, data, ops } = storage(m)
    const { books } = await s.addOpened(book(SHA_A_KEY), 'staging/1.epub')
    expect(books.map((b) => b.sha256)).toEqual([SHA_A_KEY])
    expect(data.get(`books/${SHA_A_KEY}.epub`)).toBe('retained')
    expect(data.has('staging/1.epub')).toBe(false)
    expect(ops.some((o) => o.startsWith('move staging/'))).toBe(false)
  })

  it('addOpened_RowWriteFailsAfterTheMove_RemovesTheRetainedCopyAndRethrows', async () => {
    const { storage: s, data, lib } = storage()
    data.set('staging/1.epub', 'staged')
    lib.addOpened = async () => { throw new Error('SQLITE_FULL') }
    await expect(s.addOpened(book(SHA_A_KEY), 'staging/1.epub')).rejects.toThrow('SQLITE_FULL')
    expect([...data.keys()]).toEqual([])
  })

  it('addOpened_RowWriteFailsForAnAdoptedCopy_KeepsTheCopy', async () => {
    const m = memoryFiles()
    m.data.set(`books/${SHA_A_KEY}.epub`, 'retained')
    m.data.set('staging/1.epub', 'staged')
    const { storage: s, data, lib } = storage(m)
    lib.addOpened = async () => { throw new Error('SQLITE_FULL') }
    await expect(s.addOpened(book(SHA_A_KEY), 'staging/1.epub')).rejects.toThrow('SQLITE_FULL')
    expect([...data]).toEqual([[`books/${SHA_A_KEY}.epub`, 'retained']])
  })

  it('addOpened_SameBytesConcurrently_OneEntryOneFile', async () => {
    const m = memoryFiles()
    m.data.set('staging/1.epub', 'x')
    m.data.set('staging/2.epub', 'x')
    const { storage: s, data } = storage(m)
    await Promise.all([s.addOpened(book(SHA_A_KEY), 'staging/1.epub'), s.addOpened(book(SHA_A), 'staging/2.epub')])
    expect(await s.books()).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${SHA_A_KEY}.epub`])
  })

  it('writeStore_HostileKey_RejectsAndWritesNothing', async () => {
    const { storage: s, ops } = storage()
    await expect(s.writeStore('../../x', '{}')).rejects.toThrow('not a sha256')
    await expect(s.addOpened(book('../x'), null)).rejects.toThrow('not a sha256')
    expect(ops).toEqual([])
  })

  it('writeStore_NotThisBooksEntry_Rejects', async () => {
    const { storage: s } = storage()
    await s.addOpened(book(SHA_B), null)
    await expect(s.writeStore(SHA_B, JSON.stringify({ v: 1, book: { sha256: SHA_A_KEY, size: 10 }, position: null, highlights: [] }))).rejects.toThrow('not an entry')
    await expect(s.writeStore(SHA_A, JSON.stringify({ v: 1, book: { sha256: SHA_A_KEY, size: 10 }, position: null, highlights: [] }))).rejects.toThrow('not an entry')
  })

  it('writeStore_PositionAndHighlight_ReadBackAsTheEntryAndQueued', async () => {
    const { storage: s, lib } = storage()
    const { bookId } = await s.addOpened(book(SHA_A), null)
    const h = { id: randomUUID(), cfi: CFI, index: 6, quote: 'bright', selectedText: 'bright cold', prefix: '', suffix: '', color: 'yellow', at: 1 }
    await s.writeStore(SHA_A, entry({ position: pos, highlights: [h] }))
    const back = JSON.parse((await s.readStore(SHA_A_KEY))!)
    expect(back).toMatchObject({ v: 1, book: { sha256: SHA_A_KEY, size: 10 }, position: pos, highlights: [h] })
    expect((await lib.outbox()).map((o) => `${o.kind}:${o.target}`)).toEqual([`book:${bookId}`, `state:${bookId}`, `annotation:${h.id}`])
    // The same entry again changes nothing; a moved position re-queues the state (gen 2).
    await s.writeStore(SHA_A, entry({ position: pos, highlights: [h] }))
    await s.writeStore(SHA_A, entry({ position: { ...pos, fraction: 0.5 }, highlights: [h] }))
    expect((await lib.outbox()).find((o) => o.kind === 'state')?.gen).toBe(2)
    expect((await lib.outbox()).find((o) => o.kind === 'annotation')?.gen).toBe(1)
  })

  it('writeStore_OverCapOrBlankSelection_KeptLocalNeverQueued', async () => {
    const { storage: s, lib } = storage()
    await s.addOpened(book(SHA_A), null)
    const long = { id: randomUUID(), cfi: CFI, index: 6, quote: 'x', selectedText: 'x'.repeat(4001), color: 'yellow', at: 1 }
    await s.writeStore(SHA_A, entry({ position: null, highlights: [long] }))
    expect(JSON.parse((await s.readStore(SHA_A))!).highlights).toHaveLength(1)
    expect((await lib.outbox()).filter((o) => o.kind === 'annotation')).toEqual([])
  })

  it('readingPath_NoNetworkNoAccount_OpenSaveRestoreAnswerFromSqlite', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Network request failed') })
    vi.stubGlobal('fetch', fetch)
    try {
      const { storage: s } = storage()
      await s.addOpened(book(SHA_A), null)
      await s.writeStore(SHA_A, entry({ position: pos, highlights: [] }))
      expect(JSON.parse((await s.readStore(SHA_A))!).position).toEqual(pos)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('readStore_NoSuchBook_Null', async () => {
    expect(await storage().storage.readStore(SHA_B)).toBeNull()
  })

  describe('R2 JSON library import (id remap, #1078)', () => {
    const oldLibrary = (id: string) => JSON.stringify({ v: 1, books: [{ id, sha256: SHA_A, size: 10, title: 'Old', author: 'A', originalName: 'old.epub', importedAt: 5, openedAt: 6 }] })
    const oldEntry = JSON.stringify({
      v: 1, book: { sha256: SHA_A_KEY, size: 10, name: 'old.epub' }, position: pos,
      highlights: [
        { id: 'hlx9q2', cfi: CFI, index: 6, quote: 'the whole old selection', prefix: '', suffix: '', color: 'yellow', at: 1 },
        { id: 'hlx9q3', cfi: CFI, index: 6, quote: 'x'.repeat(4001), prefix: '', suffix: '', color: 'yellow', at: 2 },
      ],
    })

    it('importLegacy_LbAndHIds_RemappedToUuidsBeforeAnyUpload_FilesDeleted', async () => {
      const m = memoryFiles()
      m.data.set('library.json', oldLibrary('lb_k3j2h1'))
      m.data.set(`store/${SHA_A_KEY}.json`, oldEntry)
      const { storage: s, lib, data } = storage(m)
      const [b] = await s.books()
      expect(isUuid(b.id)).toBe(true)
      expect(b).toMatchObject({ title: 'Old', originalName: 'old.epub', importedAt: 5, local: true })
      const back = JSON.parse((await s.readStore(SHA_A))!)
      expect(back.position).toEqual(pos)
      expect(back.highlights.map((h: { id: string }) => isUuid(h.id))).toEqual([true, true])
      // Pre-#1078: quote held the whole selection; now selectedText does, quote is its ≤64-code-point start.
      expect(back.highlights[0]).toMatchObject({ selectedText: 'the whole old selection', quote: 'the whole old selection' })
      expect(back.highlights[1].quote).toHaveLength(64)
      // The over-cap one stays on the device, unqueued.
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state', 'annotation'])
      expect([...data.keys()].filter((k) => k.endsWith('.json'))).toEqual([])
    })

    it('importLegacy_UuidBookId_Kept_SecondStartImportsNothing', async () => {
      const id = randomUUID()
      const m = memoryFiles()
      m.data.set('library.json', oldLibrary(id))
      const db = memoryDb()
      const lib = createLocalLibrary(db)
      expect((await createV2Storage(m.files, randomUUID, lib).books()).map((b) => b.id)).toEqual([id])
      m.data.set('library.json', oldLibrary('lb_again'))
      expect((await createV2Storage(m.files, randomUUID, lib).books()).map((b) => b.id)).toEqual([id])
    })

    it('importLegacy_PageResendsOldHId_SameHighlightNotDuplicated', async () => {
      const m = memoryFiles()
      m.data.set('library.json', oldLibrary('lb_1'))
      m.data.set(`store/${SHA_A_KEY}.json`, oldEntry)
      const { storage: s } = storage(m)
      await s.books()
      // A page that still held the old ids saves them back: same CFI + text is the stored highlight.
      await s.writeStore(SHA_A, oldEntry)
      expect(JSON.parse((await s.readStore(SHA_A))!).highlights).toHaveLength(2)
    })

    it('importLegacy_FailsOnceBookOpenedMeanwhile_RetriedHighlightsKeptOwnPositionKept', async () => {
      const m = memoryFiles()
      m.data.set('library.json', oldLibrary('lb_1'))
      m.data.set(`store/${SHA_A_KEY}.json`, oldEntry)
      const { storage: s, lib, data } = storage(m)
      const real = lib.importLegacy
      let failures = 1
      lib.importLegacy = (...args) => (failures-- > 0 ? Promise.reject(new Error('SQLITE_BUSY')) : real(...args))
      // The import fails; the reader still opens the book (a new row) and reads on.
      await s.addOpened(book(SHA_A), null)
      expect(data.has(`store/${SHA_A_KEY}.json`)).toBe(true)
      await s.writeStore(SHA_A, entry({ position: { ...pos, fraction: 0.9 }, highlights: [] }))
      // The next call retries: the existing row keeps its own position and gains the legacy highlights.
      const back = JSON.parse((await s.readStore(SHA_A))!)
      expect(back.position.fraction).toBe(0.9)
      expect(back.highlights).toHaveLength(2)
      expect(data.has(`store/${SHA_A_KEY}.json`)).toBe(false)
    })
  })

  describe('R2 JSON library unreadable (#1081)', () => {
    const oldLibrary = JSON.stringify({ v: 1, books: [{ id: randomUUID(), sha256: SHA_A, size: 10, title: 'Old', author: 'A', originalName: 'old.epub', importedAt: 5, openedAt: 6 }] })

    it('corruptTarget_AValidTmpBeside_TheTmpImported', async () => {
      const m = memoryFiles()
      m.data.set('library.json', '{"v":1,"books":[')
      m.data.set('library.json.tmp', oldLibrary)
      const { storage: s } = storage(m)
      expect((await s.books()).map((b) => b.title)).toEqual(['Old'])
    })

    it('neitherParses_KeptAsideAndReported_NeverDeleted_NotReadAgain', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const m = memoryFiles()
      m.data.set('library.json', 'garbage')
      m.data.set('library.json.tmp', '{"v":2}')
      const { storage: s } = storage(m)
      await s.addOpened(book(SHA_B), null)
      expect((await s.books()).map((b) => b.sha256)).toEqual([SHA_B])
      const aside = [...m.data.keys()].filter((k) => k.includes('.corrupt-')).sort()
      expect(aside.map((k) => k.replace(/\d+$/, 'N'))).toEqual(['library.json.corrupt-N', 'library.json.tmp.corrupt-N'])
      expect(aside.map((k) => m.data.get(k))).toEqual(['garbage', '{"v":2}'])
      expect(m.data.has('library.json')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept aside'))
      // The next start reads nothing and moves nothing.
      const before = m.ops.length
      await createV2Storage(m.files, randomUUID, createLocalLibrary(memoryDb())).books()
      expect(m.ops.slice(before)).toEqual([])
      warn.mockRestore()
    })

    const library = JSON.stringify({ v: 1, books: [{ id: randomUUID(), sha256: SHA_A_KEY, size: 10, title: 'Old', author: 'A', originalName: 'old.epub', importedAt: 5, openedAt: 6 }] })
    const storeEntry = JSON.stringify({ v: 1, book: { sha256: SHA_A_KEY, size: 10, name: 'old.epub' }, position: pos, highlights: [] })

    it('storeEntry_CorruptTarget_AValidTmpBeside_TheTmpImported', async () => {
      const m = memoryFiles()
      m.data.set('library.json', library)
      m.data.set(`store/${SHA_A_KEY}.json`, '{"v":1,"book":')
      m.data.set(`store/${SHA_A_KEY}.json.tmp`, storeEntry)
      const { storage: s } = storage(m)
      await s.books()
      expect(JSON.parse((await s.readStore(SHA_A))!).position).toEqual(pos)
      expect([...m.data.keys()].filter((k) => k.startsWith('store/'))).toEqual([])
    })

    it('storeEntry_NeitherParses_KeptAsideNeverDeleted_TheBookStillImported', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const m = memoryFiles()
      m.data.set('library.json', library)
      m.data.set(`store/${SHA_A_KEY}.json`, 'garbage')
      const { storage: s } = storage(m)
      expect((await s.books()).map((b) => b.title)).toEqual(['Old'])
      const aside = [...m.data.keys()].filter((k) => k.startsWith('store/'))
      expect(aside.map((k) => k.replace(/\d+$/, 'N'))).toEqual([`store/${SHA_A_KEY}.json.corrupt-N`])
      expect(m.data.get(aside[0])).toBe('garbage')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept aside'))
      warn.mockRestore()
    })

    it('noLibraryAtAll_NothingMoved_NothingReported', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const m = memoryFiles()
      const { storage: s } = storage(m)
      await s.books()
      expect(m.ops).toEqual([])
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  it('stagePicked_PickedUri_CopiedStraightIntoStaging', async () => {
    const { storage: s, data, ops } = storage()
    const staged = await s.stagePicked('content://docs/book')
    expect(staged).toMatch(/^staging\/\d+\.epub$/)
    expect(data.get(staged)).toBe('bytes of content://docs/book')
    expect(ops).toEqual([`copyIn content://docs/book ${staged}`])
  })

  it('stagePicked_DiskFullMidCopy_PartialRemovedErrorKept', async () => {
    // #1080 item 5: a copy that dies on a full disk leaves no partial file.
    const { storage: s, data } = storage()
    await expect(s.stagePicked('content://docs/full')).rejects.toThrow('ENOSPC')
    expect([...data.keys()]).toEqual([])
  })

  it('sha256Key_NotSixtyFourHex_Throws', () => {
    for (const bad of ['', 'ab'.repeat(31), `${'ab'.repeat(32)}/`, '../'.repeat(22)]) expect(() => sha256Key(bad), bad).toThrow()
  })

  it('nonceFromUuid_RandomUuid_ThirtyTwoHexThePageAccepts', () => {
    const nonce = nonceFromUuid(randomUUID())
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(v2ReaderPageHtml(nonce)).toContain(`'nonce-${nonce}'`)
    expect(() => nonceFromUuid('not-a-uuid')).toThrow()
  })
})
