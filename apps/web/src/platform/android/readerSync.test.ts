// @vitest-environment node
/**
 * The Android reader's saving (`createDeviceReaderSync`): the web ReaderSync contract over a real device library
 * (node:sqlite) and its host storage. Only the server of the sync pass is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initApi, type PagePosition } from '@textstack/shared'
import { createLocalLibrary, type LocalLibrary } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { createHostStorage, type HostFiles } from './hostStorage'
import { syncLibrary } from './librarySync'
import { resetSyncForTests, syncStore } from './syncClient'
import { NO_PLACE_YET, type SaveStatus } from '../../lib/readerSync'
import { fakeApi as fakeV2, feed, type Answer } from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'

vi.mock('./deviceDownload', () => ({ readerStorage: () => { throw new Error('the test passes its storage') } }))
vi.mock('./library', () => ({ syncSoon: () => {} }))

const { createDeviceReaderSync } = await import('./readerSync')

const V2 = 'http://api/me/v2'
const SHA = 'ab'.repeat(32)
const CFI = 'epubcfi(/6/14!/4/2/1:0)'
const NOW = Date.now()
const pos = { cfi: CFI, quote: 'It was a bright cold day', index: 6, fraction: 0.41, at: NOW - 60_000 }
const hl = { id: '11111111-1111-4111-8111-111111111111', cfi: 'epubcfi(/6/14!/4/2,/1:0,/1:5)', quote: 'It was', color: 'yellow', at: NOW - 50_000 }
const entry = (position: unknown, highlights: unknown[] = []) =>
  JSON.stringify({ v: 1, book: { sha256: SHA, size: 10, name: 'b.epub' }, position, highlights })

/** Every session a test opens, closed after it: an open one stays the mounted reader of later passes. */
const sessions: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(s: T) => { sessions.push(s); return s }

let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

/** No R2 JSON library on this device: the files are never read past the import check. */
const noFiles: HostFiles = { read: async () => null, move: async () => {}, exists: () => false, remove: () => {}, copyIn: async () => {} }

async function opened() {
  const db = memoryDb()
  const lib = createLocalLibrary(db)
  await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
  const bookId = (await lib.localBookId(SHA))!
  const fileId = (await lib.book(bookId))!.file_id!
  const storage = createHostStorage(noFiles, newId, lib)
  const target = { bookId, fileId, format: 'epub', sha256: SHA, size: 10, name: 'b.epub' }
  const sync = vi.fn()
  const seen = { statuses: [] as SaveStatus[], highlights: [] as unknown[][], offers: [] as PagePosition[], completed: [] as (string | null)[] }
  const open = (extra: object = {}) => track(createDeviceReaderSync(target, {
    onStatus: (s) => seen.statuses.push(s),
    onHighlights: (l) => seen.highlights.push(l),
    onNewerPlace: (p) => seen.offers.push(p),
    onCompleted: (c) => seen.completed.push(c),
    ...extra,
  }, { storage, sync }))
  return { db, lib, storage, bookId, fileId, open, seen, sync }
}

const positionOf = (json: string | null) => (JSON.parse(json!) as { position: PagePosition | null }).position

describe('the Android reader saves on the device', () => {
  beforeEach(() => {
    resetSyncForTests()
    n = 0
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(sessions.splice(0).map((x) => x.close()))
  })

  it('restore_AfterAStoreAndAReopen_ThePlaceSurvives', async () => {
    const { open, sync } = await opened()
    const first = open()
    expect(positionOf(await first.restore())).toBeNull()
    first.store(entry(pos))
    await first.close()
    expect(sync).toHaveBeenCalled()
    const again = open()
    const json = await again.restore()
    expect(positionOf(json)).toMatchObject({ cfi: CFI, fraction: 0.41 })
    // The place only: the highlights come by `loadHighlights`.
    expect(JSON.parse(json!).highlights).toEqual([])
  })

  it('store_BeforeRestore_NotTaken', async () => {
    const { open, lib } = await opened()
    const s = open()
    s.store(entry(pos))
    await s.close()
    expect(positionOf(await lib.readEntry(SHA))).toBeNull()
  })

  it('loadHighlights_StoredHighlightAndItsNote_RoundTrip', async () => {
    const { open, seen } = await opened()
    const first = open()
    await first.restore()
    await first.loadHighlights()
    expect(seen.highlights).toEqual([[]])
    first.store(entry(pos, [hl]))
    await first.flush()
    first.setNote(hl.id, 'a note')
    // Held at once, for the host's synchronous editor.
    expect(first.note(hl.id)).toBe('a note')
    await first.close()
    expect(seen.statuses).toContain('saved')

    const again = open()
    await again.restore()
    await again.loadHighlights()
    expect(seen.highlights[1]).toEqual([expect.objectContaining({ id: hl.id, cfi: hl.cfi })])
    expect(again.note(hl.id)).toBe('a note')
    expect(again.deleted(hl.id)).toBe(false)
    await again.close()
  })

  it('remove_AStoredHighlight_DeletedHereAndNotRestored', async () => {
    const { open, seen } = await opened()
    const s = open()
    await s.restore()
    await s.loadHighlights()
    s.store(entry(pos, [hl]))
    await s.flush()
    s.remove(hl.id)
    expect(s.deleted(hl.id)).toBe(true)
    // A note on a removed highlight is ignored.
    s.setNote(hl.id, 'late')
    await s.close()

    const again = open()
    await again.restore()
    await again.loadHighlights()
    expect(seen.highlights[1]).toEqual([])
    expect(again.deleted(hl.id)).toBe(true)
    expect(again.note(hl.id)).toBeNull()
    await again.close()
  })

  it('complete_NoPlaceYet_RejectsWithNoPlaceYet_NothingFinished', async () => {
    const { open, lib } = await opened()
    const s = open()
    await s.restore()
    await expect(s.complete()).rejects.toThrow(NO_PLACE_YET)
    expect((await lib.books()).map((b) => b.finished)).toEqual([false])
    await s.close()
  })

  it('complete_WithAPlace_FinishedOnce_TheSameCompletedAtAgain', async () => {
    const { open, lib, seen } = await opened()
    const s = open()
    await s.restore()
    expect(seen.completed).toEqual([null])
    // The place just stored is written first.
    s.store(entry(pos))
    const at = await s.complete()
    expect(at).toEqual(expect.any(String))
    expect(seen.completed).toEqual([null, at])
    expect(await s.complete()).toBe(at)
    expect((await lib.books()).map((b) => b.completedAt)).toEqual([at])
    await s.close()
    // A reopen tells the host the book is finished.
    const again = open()
    await again.restore()
    expect(seen.completed[seen.completed.length - 1]).toBe(at)
    await again.close()
  })

  it('everyMember_Offline_NoNetworkCall', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetch)
    const { open, seen } = await opened()
    const s = open()
    await s.restore()
    await s.loadHighlights()
    s.store(entry(pos, [hl]))
    await s.flush()
    s.setNote(hl.id, 'offline')
    s.flushKeepalive(entry({ ...pos, fraction: 0.5 }, [hl]))
    await s.complete()
    s.remove(hl.id)
    await s.close(entry({ ...pos, fraction: 0.6 }, [hl]))
    expect(fetch).not.toHaveBeenCalled()
    expect(seen.statuses).not.toContain('unsaved')
    const again = open()
    expect(positionOf(await again.restore())).toMatchObject({ fraction: 0.6 })
    await again.close()
  })

  it('store_TheWriteFails_UnsavedThenWrittenByTheFlush', async () => {
    const { open, storage, lib, seen } = await opened()
    const write = storage.writeStore
    storage.writeStore = vi.fn(write).mockRejectedValueOnce(new Error('SQLITE_FULL'))
    const s = open()
    await s.restore()
    s.store(entry(pos))
    await s.flush()
    expect(seen.statuses[seen.statuses.length - 1]).toBe('unsaved')
    // The same payload again is no change: the flush writes what did not land.
    await s.flush()
    expect(seen.statuses[seen.statuses.length - 1]).not.toBe('unsaved')
    expect(positionOf(await lib.readEntry(SHA))).toMatchObject({ cfi: CFI })
    await s.close()
  })

  it('store_AGuestMintOrSignInWhileReading_StillSaved', async () => {
    const { open, lib, seen } = await opened()
    const s = open()
    await s.restore()
    // A new session resets the V2 caches and their epoch (account.ts `begin`): the reading path needs no account.
    syncStore.reset()
    s.store(entry(pos))
    await s.flush()
    expect(positionOf(await lib.readEntry(SHA))).toMatchObject({ cfi: CFI })
    expect(seen.statuses).not.toContain('unsaved')
    await s.close()
  })

  it('store_TheLibraryWipedWhileReading_UnsavedNotSilent', async () => {
    const { open, lib, seen } = await opened()
    const s = open()
    await s.restore()
    // Sign-out (#1070): the rows go; nothing may be written for another account, and the reader is told.
    await lib.wipe()
    s.store(entry(pos))
    await s.flush()
    expect(seen.statuses[seen.statuses.length - 1]).toBe('unsaved')
    expect(await lib.readEntry(SHA)).toBeNull()
    await s.close()
  })

  it('setNote_ANoteNeverReadOnTheDevice_RefusedAndUnsaved_TheRealNoteKept', async () => {
    const { db, open, lib, seen } = await opened()
    await lib.writeEntry(SHA, entry(pos, [hl]), newId)
    // A row from before notes were kept: its server note not read yet (Expo shows the editor loading).
    db.raw.prepare('UPDATE annotations SET note = ?, note_known = 0 WHERE id = ?').run('the real note', hl.id)
    const s = open()
    await s.restore()
    await s.loadHighlights()
    s.setNote(hl.id, 'typed over')
    await s.flush()
    expect(seen.statuses[seen.statuses.length - 1]).toBe('unsaved')
    await s.close()
    expect(db.raw.prepare('SELECT note FROM annotations WHERE id = ?').get(hl.id)).toEqual({ note: 'the real note' })
  })

  it('close_TheEditorsNoteBeforeTheLastStoreThatMakesItsHighlight_BothSaved', async () => {
    const { open, seen } = await opened()
    const s = open()
    await s.restore()
    await s.loadHighlights()
    // Pagehide's order in ReaderHost: `flushDraft` (the note) first, then the page's last store with `close(last)`.
    s.setNote(hl.id, 'from the editor')
    expect(s.note(hl.id)).toBe('from the editor')
    await s.close(entry(pos, [hl]))
    const again = open()
    await again.restore()
    await again.loadHighlights()
    expect(seen.highlights[1]).toEqual([expect.objectContaining({ id: hl.id })])
    expect(again.note(hl.id)).toBe('from the editor')
    await again.close()
  })

  it('setNote_ItsHighlightNotStoredYet_KeptAndUnsaved_WrittenByTheNextStore', async () => {
    const { open, seen } = await opened()
    const s = open()
    await s.restore()
    await s.loadHighlights()
    s.setNote(hl.id, 'early')
    await s.flush()
    // No row yet: kept in memory, said as unsaved.
    expect(s.note(hl.id)).toBe('early')
    expect(seen.statuses[seen.statuses.length - 1]).toBe('unsaved')
    s.store(entry(pos, [hl]))
    await s.flush()
    expect(seen.statuses[seen.statuses.length - 1]).toBe('saved')
    await s.close()
    const again = open()
    await again.restore()
    await again.loadHighlights()
    expect(again.note(hl.id)).toBe('early')
    await again.close()
  })

  it('close_HighlightsNotReadYet_NoReadStarted', async () => {
    const { open, storage } = await opened()
    const read = vi.spyOn(storage, 'readStore')
    const s = open()
    await s.restore()
    await s.close(entry(pos))
    // The restore's read only: a highlights read on close would draw nothing.
    expect(read).toHaveBeenCalledTimes(1)
  })

  describe('a sync pass while the book is open', () => {
    const ok = (body: unknown, status = 200): Answer => ({ status, body })
    const serverBook = (id: string, fileId: string) => ({
      id, title: 'T', author: null, tags: [], hasCover: false, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', removedAt: null,
      currentFile: { id: fileId, sha256: SHA, byteSize: 10, originalName: 'b.epub', format: 'epub', hasContent: false, contentRemovedAt: null, isCurrent: true },
    })
    const OTHER = 'epubcfi(/6/20!/4/2/1:0)'
    const serverState = (bookId: string, fileId: string, revision: number, cfi = CFI, at = pos.at) => ({
      bookId, fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi, quote: pos.quote }, bookFraction: 0.8,
      frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: new Date(at).toISOString(),
      updatedAt: '2026-11-10T00:00:01Z', revision, resetRevision: null,
    })
    const routes = (r: Record<string, Answer[]>) => fakeV2({
      'GET /status': [ok({ maxPartBytes: 1024 })], 'GET /library/changes': feed(), 'GET /reading/changes': feed(), 'GET /annotations/changes': feed(), 'GET /vocabulary/changes': feed(), ...r,
    }, V2)
    /** A pass as the app asks one (no reader of its own): the mounted reader takes the open book's part. */
    const appPass = (lib: LocalLibrary) => syncLibrary(lib, { userId: 'u1', newId, reader: () => null, guest: false })

    beforeEach(() => initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null }))

    async function pushed() {
      const o = await opened()
      await o.lib.writeEntry(SHA, entry(pos), newId)
      routes({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${o.bookId}`]: [ok(serverBook(o.bookId, o.fileId), 201)], [`PUT /books/${o.bookId}/reading-state`]: [ok(serverState(o.bookId, o.fileId, 1))] })
      expect(await appPass(o.lib)).toBe('done')
      return o
    }

    it('pull_ANewerPlaceElsewhere_OfferedNotApplied', async () => {
      const { lib, open, seen, bookId, fileId } = await pushed()
      const s = open()
      await s.restore()
      routes({ 'GET /reading/changes': feed(serverState(bookId, fileId, 2, OTHER, NOW)) })
      await appPass(lib)
      expect(seen.offers).toEqual([expect.objectContaining({ cfi: OTHER })])
      // The reader is never moved: the place here stays ours.
      expect(positionOf(await lib.readEntry(SHA))).toMatchObject({ cfi: CFI })
      await s.close()
    })

    it('pull_BeforeTheRestoreSettled_AdoptedAndRestoredThere_NoOffer', async () => {
      const { lib, open, seen, bookId, fileId } = await pushed()
      const s = open()
      // Not restored yet (Expo `place.reader()`): ADR-019 adopts the newer place, and the restore opens at it.
      routes({ 'GET /reading/changes': feed(serverState(bookId, fileId, 2, OTHER, NOW)) })
      await appPass(lib)
      expect(seen.offers).toEqual([])
      expect(positionOf(await s.restore())).toMatchObject({ cfi: OTHER })
      await s.close()
    })

    it('close_ReleasesTheReaderHost_ALaterPullOffersNothing', async () => {
      const { lib, open, seen, bookId, fileId } = await pushed()
      const s = open()
      await s.restore()
      await s.close()
      routes({ 'GET /reading/changes': feed(serverState(bookId, fileId, 2, OTHER, NOW)) })
      await appPass(lib)
      expect(seen.offers).toEqual([])
      // No reader open: the newer place is the book's now (ADR-019 adopt).
      expect(positionOf(await lib.readEntry(SHA))).toMatchObject({ cfi: OTHER })
    })
  })
})
