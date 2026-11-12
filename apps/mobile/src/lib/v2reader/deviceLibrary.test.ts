import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { memoryDb } from './sqliteShim'
import { signOutLoss } from './localLibrary'

// deviceLibrary loads expo-sqlite and expo-file-system with a plain `require`, which vi.mock does not
// reach: seed Node's cache. The file system is a memory one; opening a database creates its file, as on a device.
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
  openDatabaseAsync: async (name: string) => {
    opens++
    if (failOpen) throw new Error(failOpen)
    files.set(`doc/SQLite/${name}`, 4096)
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
  delete() {
    if (!this.exists) throw new Error('directory does not exist')
    for (const p of [...files.keys()].filter(under(this.uri))) files.delete(p)
    for (const p of [...dirs].filter((d) => d === this.uri || under(this.uri)(d))) dirs.delete(p)
  }
}
class File {
  uri: string
  constructor(...parts: unknown[]) { this.uri = join(parts) }
  get exists() { return files.has(this.uri) }
}
seed('expo-file-system', { Directory, File, Paths: { document: 'doc' } })

/** The module afresh: its open database and library are per process. */
const fresh = async () => {
  vi.resetModules()
  return import('./deviceLibrary')
}
const SHA = 'cd'.repeat(32)
const TABLES = ['books', 'reading_state', 'annotations', 'outbox', 'meta']
const rows = (table: string) => (db!.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

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
  for (const d of ['doc/v2', 'doc/v2/books', 'doc/v2/staging']) dirs.add(d)
  files.set(`doc/v2/books/${SHA}.epub`, 1000)
  files.set('doc/v2/staging/1.epub', 500)
  for (const t of TABLES) expect(rows(t), t).toBeGreaterThan(0)
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

  describe('never created (the reader is __DEV__-only): measuring, the loss check and the wipe create nothing', () => {
    it('neverCreated_MeasureLossAndWipe_NoDatabaseOpenedNoDirectoryCreated', async () => {
      const m = await fresh()
      expect(m.deviceV2Bytes()).toBe(0)
      expect(await m.deviceV2SignOutLoss()).toEqual({ books: 0, writes: 0 })
      await m.wipeDeviceV2Library()
      expect(opens).toBe(0)
      expect([...files.keys(), ...dirs]).toEqual([])
    })
  })

  it('measure_BooksAndStaging_CountedUnderV2', async () => {
    const m = await fresh()
    await used(m)
    files.set('doc/elsewhere.epub', 7)
    expect(m.deviceV2Bytes()).toBe(1500)
  })

  it('signOutLoss_UnsyncedBookAndQueuedWrites_Counted', async () => {
    const m = await fresh()
    await used(m)
    expect(await m.deviceV2SignOutLoss()).toEqual({ books: 1, writes: 3 })
  })

  it('wipe_UsedLibrary_EveryTableEmptyFilesGoneNothingRecreated', async () => {
    const m = await fresh()
    const lib = await used(m)
    await m.wipeDeviceV2Library()
    for (const t of TABLES) expect(rows(t), t).toBe(0)
    expect([...dirs]).toEqual([])
    expect([...files.keys()]).toEqual(['doc/SQLite/textstack-v2'])
    expect(await lib.books()).toEqual([])
    expect(await lib.account()).toBeNull()
    expect(await m.deviceV2SignOutLoss()).toEqual({ books: 0, writes: 0 })
  })

  it('wipe_DatabaseCannotOpen_FilesStillDeletedAndTheFailureThrown', async () => {
    const m = await fresh()
    files.set('doc/SQLite/textstack-v2', 4096)
    dirs.add('doc/v2')
    files.set('doc/v2/staging/1.epub', 500)
    failOpen = 'disk busy'
    await expect(m.wipeDeviceV2Library()).rejects.toThrow(/not fully wiped: disk busy/)
    expect([...dirs]).toEqual([])
    expect(files.has('doc/v2/staging/1.epub')).toBe(false)
  })
})

describe('signOutLoss (what sign-out deletes that the server lacks)', () => {
  const book = (extra: object = {}) => ({ imported_at: 1, file_id: 'f', server_file_id: 'f', has_content: 1, content_removed: 0, ...extra })

  it('signOutLoss_EachWayAFileIsNotOnTheServer_CountedOnce', () => {
    expect(signOutLoss([
      book(), // on the server with its bytes
      book({ server_file_id: null, has_content: 0 }), // never pushed
      book({ has_content: 0 }), // pushed, bytes not (file sync off)
      book({ server_file_id: 'g' }), // replaced on another device: this copy is not there
      book({ content_removed: 1 }), // bytes removed there
      book({ imported_at: null, file_id: null, server_file_id: 'g' }), // on the server only: nothing here to lose
    ], 4)).toEqual({ books: 4, writes: 4 })
  })

  it('signOutLoss_EverythingSynced_NothingLost', () => {
    expect(signOutLoss([book()], 0)).toEqual({ books: 0, writes: 0 })
  })
})
