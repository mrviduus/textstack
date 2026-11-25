import { describe, it, expect } from 'vitest'
import { rankContinueReading } from '@textstack/shared'
import { cachedUserBook, cachedUserBookDetail, deviceUserBooks } from './cachedUserBookDetail'
import type { LibraryBook } from './reader/hostStorage'
import { createLocalLibrary } from './reader/localLibrary'
import { memoryDb } from './reader/sqliteShim'

const onDevice: LibraryBook = {
  id: 'book-1', sha256: 'a'.repeat(64), size: 1000, title: 'Designing Data-Intensive Applications',
  author: 'Martin Kleppmann', originalName: 'ddia.epub', importedAt: 1_757_000_000_000, openedAt: 0,
  local: true, notSynced: null, finished: false, completedAt: null, format: 'epub',
}

describe('cachedUserBookDetail', () => {
  it('offline, a book whose file is on the device opens: Ready, with its file, title and author', () => {
    const book = cachedUserBookDetail(onDevice)
    expect(book).toMatchObject({ id: 'book-1', status: 'Ready', hasFile: true, title: onDevice.title, author: 'Martin Kleppmann' })
  })

  it('claims nothing the device does not have', () => {
    const book = cachedUserBookDetail({ ...onDevice, author: '' })
    expect(book.author).toBeNull()
    expect(book.description).toBeNull()
    expect(book.coverPath).toBeNull()
    expect(book.chapters).toEqual([])
  })
})

describe('cachedUserBook (#1532)', () => {
  it('cachedUserBook_ReadToAThirdThenOfflineColdStart_RowShowsProgressAndContinue', async () => {
    const db = memoryDb()
    const SHA = 'cd'.repeat(32)
    let n = 0
    const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
    const reading = createLocalLibrary(db)
    await reading.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
    const at = Date.now() - 60_000
    const position = { cfi: 'epubcfi(/6/14!/4/2/1:0)', quote: 'q', index: 6, fraction: 0.3, at }
    await reading.writeEntry(SHA, JSON.stringify({ v: 1, book: { sha256: SHA, size: 10, name: 'b.epub' }, position, highlights: [] }), newId)

    // The app killed: a new process opens the same database, no account and no network involved.
    const lib = createLocalLibrary(db)
    const [book] = (await lib.books()).filter((b) => b.local)
    const row = cachedUserBook(book, (await lib.progress()).get(book.id))

    expect(row).toMatchObject({ id: book.id, progressPercent: 0.3, progressUpdatedAt: new Date(at).toISOString() })
    const [pick] = rankContinueReading({ library: [], serverProgress: [], userBooks: [row], localCatalogMap: new Map(), localUserBookMap: new Map() })
    expect(pick).toMatchObject({ type: 'userbook', id: book.id, percent: 0.3 })
  })

  it('cachedUserBook_FinishedThenOfflineColdStart_RowAndBookPageShowRead', async () => {
    const db = memoryDb()
    const SHA = 'ef'.repeat(32)
    const reading = createLocalLibrary(db)
    await reading.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.fb2', format: 'fb2' }, () => '00000000-0000-4000-8000-000000000001')
    await reading.finish(SHA, '2026-11-20T10:00:00.000Z')

    const lib = createLocalLibrary(db)
    const [book] = (await lib.books()).filter((b) => b.local)

    expect(cachedUserBook(book, undefined).completedAt).toBe('2026-11-20T10:00:00.000Z')
    expect(cachedUserBookDetail(book).completedAt).toBe('2026-11-20T10:00:00.000Z')
  })
})

describe('deviceUserBooks (#1608)', () => {
  it('deviceUserBooks_SignedOutWithABookReadHereAndOneOnlyOnTheServer_ListsTheBookOnTheDeviceWithItsPlace', async () => {
    const db = memoryDb()
    const SHA = 'ef'.repeat(32)
    let n = 0
    const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
    const lib = createLocalLibrary(db)
    await lib.addOpened({ sha256: SHA, size: 10, title: 'Here', author: '', originalName: 'b.epub', format: 'epub' }, newId)
    const position = { cfi: 'epubcfi(/6/14!/4/2/1:0)', quote: 'q', index: 6, fraction: 0.5, at: Date.now() }
    await lib.writeEntry(SHA, JSON.stringify({ v: 1, book: { sha256: SHA, size: 10, name: 'b.epub' }, position, highlights: [] }), newId)
    // A book the server listed but whose file never came to this device.
    await lib.applyBooks([{
      id: 'server-only', title: 'Elsewhere', author: null, tags: [], hasCover: false, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', removedAt: null,
      currentFile: { id: 'f-server', sha256: '12'.repeat(32), byteSize: 10, originalName: 'e.epub', format: 'epub', hasContent: false, contentRemovedAt: null, isCurrent: true },
    } as never])

    const rows = await deviceUserBooks(lib)

    expect(rows.map(r => r.title)).toEqual(['Here'])
    expect(rows[0]).toMatchObject({ status: 'Ready', progressPercent: 0.5 })
  })
})
