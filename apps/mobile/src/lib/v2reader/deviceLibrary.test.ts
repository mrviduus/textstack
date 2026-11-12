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
  get size() { return this.exists ? [...files].filter(([p]) => under(this.uri)(p)).reduce((n, [, s]) => n + s, 0) : null }
  create() {
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
  m.makeV2Dirs()
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

  it('neverCreated_MeasureAndWipe_NoDirectoryCreatedMeasureOpensNothing', async () => {
    const m = await fresh()
    expect(m.deviceV2Bytes()).toBe(0)
    expect(opens).toBe(0)
    await m.wipeDeviceV2Library()
    expect([...dirs, ...files.keys()]).toEqual([])
  })

  it('measure_BooksAndStaging_CountedUnderV2Only', async () => {
    const m = await fresh()
    await used(m)
    files.set('doc/elsewhere.epub', 7)
    expect(m.deviceV2Bytes()).toBe(1500)
  })

  it('signOutLoss_NeverPushedBook_OneBookItsChangesNotCountedAgain', async () => {
    const m = await fresh()
    await used(m)
    expect(await m.deviceV2SignOutLoss()).toEqual({ books: 1, writes: 0 })
  })

  it('wipe_UsedLibrary_RowsGoneIdentityKeptFilesGoneDirectoriesBack', async () => {
    const m = await fresh()
    const lib = await used(m)
    await m.wipeDeviceV2Library()
    for (const t of ['books', 'reading_state', 'annotations', 'outbox']) expect(rows(t), t).toBe(0)
    expect(db!.raw.prepare('SELECT key FROM meta').all()).toEqual([{ key: 'account' }])
    expect([...files.keys()]).toEqual([])
    // Made again in the one place, so the host's next write (staging, books) finds them.
    expect([...dirs].sort()).toEqual([...HOST_DIRS].sort())
    expect(await lib.books()).toEqual([])
    expect(await m.deviceV2SignOutLoss()).toEqual({ books: 0, writes: 0 })
  })

  it('wipe_DatabaseCannotOpen_StopsBeforeTheFilesAndThrows', async () => {
    const m = await fresh()
    m.makeV2Dirs()
    files.set(`doc/v2/books/${SHA}.epub`, 1000)
    failOpen = 'disk busy'
    await expect(m.wipeDeviceV2Library()).rejects.toThrow('disk busy')
    // No row is left naming a missing file: the files stay until the rows can go.
    expect(files.has(`doc/v2/books/${SHA}.epub`)).toBe(true)
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
