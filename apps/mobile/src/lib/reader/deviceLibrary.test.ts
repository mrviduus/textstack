import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { memoryDb } from './sqliteShim'
import { signOutLoss } from './localLibrary'

// deviceLibrary loads expo-sqlite and expo-file-system with a plain `require`, which vi.mock does not
// reach: seed Node's cache. The file system is a memory one.
const files = new Map<string, number>()
const dirs = new Set<string>()
let opens = 0
let failOpen: string | null = null
/** Directory creations that throw before they work again. */
let failCreate = 0
let db: ReturnType<typeof memoryDb> | null = null

const req = createRequire(import.meta.url)
const seed = (name: string, exports: object) => {
  const path = req.resolve(name)
  req.cache[path] = { id: path, filename: path, loaded: true, exports } as never
}
seed('expo-sqlite', {
  openDatabaseAsync: async () => {
    opens++
    if (failOpen) throw new Error(failOpen)
    return (db = memoryDb())
  },
})
const join = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/')
const under = (dir: string) => (p: string) => p.startsWith(`${dir}/`)
class Directory {
  uri: string
  constructor(...parts: unknown[]) { this.uri = join(parts) }
  get exists() { return dirs.has(this.uri) }
  list() { return [...files.keys()].filter(under(this.uri)).map((p) => ({ name: p.slice(this.uri.length + 1), delete: () => files.delete(p) })) }
  get size() { return this.exists ? [...files].filter(([p]) => under(this.uri)(p)).reduce((n, [, s]) => n + s, 0) : null }
  create() {
    if (failCreate > 0) { failCreate--; throw new Error('create failed') }
    const segments = this.uri.split('/')
    for (let i = 2; i <= segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
  }
  delete() {
    if (!this.exists) throw new Error('directory does not exist')
    for (const p of [...files.keys()].filter(under(this.uri))) files.delete(p)
    for (const p of [...dirs].filter((d) => d === this.uri || under(this.uri)(d))) dirs.delete(p)
  }
}
seed('expo-file-system', { Directory, Paths: { document: 'doc' } })

/** The module afresh: its open database and library are per process. */
const fresh = async () => {
  vi.resetModules()
  return import('./deviceLibrary')
}
const SHA = 'cd'.repeat(32)
/** AsyncStorage as the current module registry sees it (the mock is per registry, like a process's view of the disk). */
const storage = async () => (await import('@react-native-async-storage/async-storage')).default
const PENDING = 'textstack_v2_wipe_pending'
/** The disk after a restart: the marker carried over into the new registry's storage. */
const restore = async (marker: string | null) => { if (marker) await (await storage()).setItem(PENDING, marker) }
const rows = (table: string) => (db!.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const HOST_DIRS = ['doc/v2', 'doc/v2/books', 'doc/v2/store', 'doc/v2/staging']

/** A library that used every table, and its files. */
async function used(m: Awaited<ReturnType<typeof fresh>>) {
  const lib = m.deviceLocalLibrary()
  let n = 0
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
  const hl = { id: '0b6a2c1e-1111-4222-8333-444455556666', cfi: 'epubcfi(/6/14!/4/2/1:0)', index: 6, quote: 'bright', selectedText: 'bright cold', prefix: 'a ', suffix: ' day', color: 'yellow', at: 1 }
  const pos = { cfi: 'epubcfi(/6/14!/4/2/1:0)', quote: 'It was a bright cold day', index: 6, fraction: 0.41, at: Date.now() }
  await lib.writeEntry(SHA, JSON.stringify({ v: 1, book: { sha256: SHA, size: 10, name: 'b.epub' }, position: pos, highlights: [hl] }), newId)
  await lib.setAccount('u1')
  await lib.setFileSync(true)
  m.makeFileDirs()
  files.set(`doc/v2/books/${SHA}.epub`, 1000)
  files.set('doc/v2/staging/1.epub', 500)
  for (const t of ['books', 'reading_state', 'annotations', 'outbox', 'meta']) expect(rows(t), t).toBeGreaterThan(0)
  return lib
}

describe('device V2 local library', () => {
  beforeEach(() => {
    files.clear()
    dirs.clear()
    opens = 0
    failOpen = null
    failCreate = 0
    db = null
  })

  it('deviceLocalLibrary_FirstOpenFails_NextCallOpensAgain', async () => {
    const { deviceLocalLibrary } = await fresh()
    failOpen = 'disk busy'
    await expect(deviceLocalLibrary().books()).rejects.toThrow('disk busy')
    failOpen = null
    expect(await deviceLocalLibrary().books()).toEqual([])
    expect(opens).toBe(2)
  })

  it('neverCreated_MeasureCreatesNothing_WipeLeavesOnlyTheEmptyDirectories', async () => {
    const m = await fresh()
    expect(m.deviceLibraryBytes()).toBe(0)
    expect(opens).toBe(0)
    expect([...dirs, ...files.keys()]).toEqual([])
    await m.wipeDeviceLibrary()
    expect([...files.keys()]).toEqual([])
    expect([...dirs].sort()).toEqual([...HOST_DIRS].sort())
  })

  it('clearFiles_DirectoriesFailOnce_NextCallMakesThemAgain', async () => {
    const m = await fresh()
    m.makeFileDirs()
    files.set('doc/v2/staging/1.epub', 500)
    failCreate = 1
    expect(() => m.clearDeviceFiles()).toThrow('create failed')
    expect(dirs.has('doc/v2/books')).toBe(false)
    m.clearDeviceFiles()
    expect([...dirs].sort()).toEqual([...HOST_DIRS].sort())
    expect([...files.keys()]).toEqual([])
  })

  it('sweepStaging_LeftoversOfAnEarlierProcessAndALiveDownload_OnlyTheLeftoversGo', async () => {
    const m = await fresh()
    m.makeFileDirs()
    const live = `doc/v2/staging/dl-${Date.now()}.epub`
    files.set(`doc/v2/staging/${Date.now() - 60_000}.epub`, 1) // an open that never finished before a restart
    files.set('doc/v2/staging/picked.epub', 1) // no time in its name: an earlier build's
    files.set(live, 1) // the book page's Download, still writing when the reader starts (#1526)
    m.sweepStaging()
    expect([...files.keys()]).toEqual([live])
  })

  it('measure_BooksAndStaging_CountedUnderV2Only', async () => {
    const m = await fresh()
    await used(m)
    files.set('doc/elsewhere.epub', 7)
    expect(m.deviceLibraryBytes()).toBe(1500)
  })

  it('signOutLoss_NeverPushedBook_OneBookItsChangesNotCountedAgain', async () => {
    const m = await fresh()
    await used(m)
    expect(await m.deviceSignOutLoss()).toEqual({ books: 1, writes: 0 })
  })

  it('wipe_UsedLibrary_EveryRowOwnerIncludedFilesGoneDirectoriesBack', async () => {
    const m = await fresh()
    const lib = await used(m)
    await m.wipeDeviceLibrary()
    // The owner too (#1070 rule A): an emptied library belongs to nobody.
    for (const t of ['books', 'reading_state', 'annotations', 'outbox']) expect(rows(t), t).toBe(0)
    // Of meta, only the notes upgrade's marker stays (#1312 review: it is about the database, not its owner).
    expect(rows('meta'), 'meta').toBe(1)
    expect([...files.keys()]).toEqual([])
    // Made again in the one place, so the host's next write (staging, books) finds them.
    expect([...dirs].sort()).toEqual([...HOST_DIRS].sort())
    expect(await lib.books()).toEqual([])
    expect(await m.deviceSignOutLoss()).toEqual({ books: 0, writes: 0 })
  })

  it('wipe_DatabaseCannotOpen_StopsBeforeTheFilesAndThrows', async () => {
    const m = await fresh()
    m.makeFileDirs()
    files.set(`doc/v2/books/${SHA}.epub`, 1000)
    failOpen = 'disk busy'
    await expect(m.wipeDeviceLibrary()).rejects.toThrow('disk busy')
    // No row is left naming a missing file: the files stay until the rows can go.
    expect(files.has(`doc/v2/books/${SHA}.epub`)).toBe(true)
  })

  it('signedOutMayList_LostAccountLists_FailedSignOutWipeHiddenAcrossARestartUntilARetryOrASignIn', async () => {
    // #1608: the server lost the account; nobody signed out here, so the device's books are still this reader's.
    const m = await fresh()
    await used(m)
    expect(await m.signedOutMayList()).toBe(true)

    // The reader signs out and the wipe fails: the rows left are the signed-out account's.
    failOpen = 'disk busy'
    const m1 = await fresh()
    await m1.wipeDeviceLibrary().catch(() => {})
    expect(await m1.signedOutMayList()).toBe(false)

    // The app restarts (a new module; the marker is on disk): still hidden while the wipe cannot run.
    const marker = await (await storage()).getItem(PENDING)
    const m2 = await fresh()
    await restore(marker)
    expect(await m2.signedOutMayList()).toBe(false)

    // The disk is back: the gate retries the wipe, which works, so the (now empty) library may list.
    failOpen = null
    expect(await m2.signedOutMayList()).toBe(true)
    expect(await m2.deviceLocalLibrary().books()).toEqual([])
  })

  it('clearWipePending_ASessionClaimedTheLibrary_ItsBooksListAfterALostSession', async () => {
    failOpen = 'disk busy'
    const m = await fresh()
    await m.wipeDeviceLibrary().catch(() => {})
    failOpen = null
    await used(m)
    // The same account signs in again (claimLibrary done): the library is its, not a wipe owed.
    await m.clearWipePending()
    expect(await m.signedOutMayList()).toBe(true)
    expect(await m.deviceLocalLibrary().books()).toHaveLength(1)
  })
})

describe('signOutLoss (what a wipe deletes that the server lacks)', () => {
  let id = 0
  const book = (extra: object = {}) => ({ id: `b${++id}`, imported_at: 1, file_id: 'f', server_file_id: 'f', has_content: 1, content_removed: 0, removed_at: null, ...extra })

  it('signOutLoss_EachWayAFileIsNotOnTheServer_CountedOnce', () => {
    expect(signOutLoss([
      book(), // on the server with its bytes
      book({ server_file_id: null, has_content: 0 }), // never pushed
      book({ has_content: 0 }), // pushed, bytes not (file sync off)
      book({ server_file_id: 'g' }), // replaced on another device: this copy is not there
      book({ content_removed: 1 }), // bytes removed there
      book({ removed_at: '2026-11-12T00:00:00Z' }), // removed there, kept here
      book({ imported_at: null, file_id: null, server_file_id: 'g' }), // on the server only: nothing here to lose
    ], [])).toEqual({ books: 5, writes: 0 })
  })

  it('signOutLoss_ChangesOfABookOnTheServer_CountedThoseOfALostBookNot', () => {
    const synced = book()
    const lost = book({ server_file_id: null, has_content: 0 })
    expect(signOutLoss([synced, lost], [{ book_id: synced.id }, { book_id: synced.id }, { book_id: lost.id }, { book_id: null }]))
      .toEqual({ books: 1, writes: 3 })
  })

  it('signOutLoss_EverythingSynced_NothingLost', () => {
    expect(signOutLoss([book()], [])).toEqual({ books: 0, writes: 0 })
  })
})
