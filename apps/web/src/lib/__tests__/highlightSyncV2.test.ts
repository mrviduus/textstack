import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { V2Annotation } from '@textstack/shared'
import type { StoredHighlight, TextAnchor } from '../offlineDb'

// IndexedDB as a map: what the sync reads and writes; `duringDelete` runs inside a delete's await.
const db = new Map<string, StoredHighlight>()
let duringDelete: (() => void) | undefined
vi.mock('../offlineDb', () => ({
  getHighlightsForEdition: async () => [],
  getHighlightsForUserBook: async (bookId: string) => [...db.values()].filter((h) => h.userBookId === bookId),
  getAllStoredHighlights: async () => [...db.values()],
  saveHighlight: async (h: StoredHighlight) => { db.set(h.id, h) },
  deleteHighlight: async (id: string) => { db.delete(id); duringDelete?.() },
}))

import { fromV2Annotation, toV2Write, syncBookHighlights } from '../highlightSync'
import { startV2Probe, resetV2ForTests, v2Store } from '../../api/v2'
import { fakeApi, asFake, V2_ON, book, feed, conflict, resetMidCall, type Answer } from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

const text: TextAnchor = { prefix: 'before ', exact: 'the quote', suffix: ' after', startOffset: 7, endOffset: 16, chapterId: '2-the-woods' }

/** A reflow anchor without offsets: V2 refuses it as textstack-anchor-v1 (#1139). */
const bare = { prefix: 'before ', exact: 'the quote', suffix: ' after', chapterId: '2-the-woods' } as unknown as TextAnchor

const annotation = (id: string, extra: Partial<V2Annotation> = {}): V2Annotation => ({
  id, bookId: 'b1', fileId: 'f1', selectedText: 'the quote', noteText: null, color: 'pink',
  locator: { version: 1, scheme: 'textstack-anchor-v1', value: { chapterKey: '2-the-woods', prefix: 'before ', exact: 'the quote', suffix: ' after', startOffset: 7, endOffset: 16 } },
  createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:01Z', deletedAt: null, revision: 3, ...extra,
})

const local = (id: string, extra: Partial<StoredHighlight> = {}): StoredHighlight => ({
  id, editionId: '', chapterId: '2-the-woods', userBookId: 'b1', anchor: text, color: 'yellow', selectedText: 'the quote',
  syncStatus: 'pending', version: 0, createdAt: 1, updatedAt: 1, ...extra,
})

describe('the V2 highlight row', () => {
  it('reads a textstack-anchor-v1 annotation as a highlight on its chapter key, version = revision', () => {
    expect(fromV2Annotation(annotation('a1'))).toMatchObject({ id: 'a1', userBookId: 'b1', chapterId: '2-the-woods', anchor: text, version: 3, syncStatus: 'synced' })
  })

  it('leaves out an annotation this reader cannot draw (an epub-cfi from the V2 reader)', () => {
    expect(fromV2Annotation(annotation('a1', { locator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)' } }))).toBeNull()
  })

  it('cuts the selection to the one cap, never inside a surrogate pair', () => {
    const long = 'a'.repeat(3999) + '😀' + 'tail'
    const body = toV2Write(local('h1', { selectedText: long, anchor: { ...text, exact: long } }), 'f1', null)
    expect(body.selectedText).toBe('a'.repeat(3999))
    expect(body).toMatchObject({ expectedRevision: null, bookId: 'b1', fileId: 'f1', color: 'yellow', noteText: null, locator: { scheme: 'textstack-anchor-v1' } })
  })
})

describe('the V2 highlight sync', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    db.clear()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fakeApi(V2_ON)
    await startV2Probe()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetV2ForTests()
  })

  const routes = (annotations: unknown[], puts: Record<string, unknown[]> = {}) => fakeApi({
    'GET /me/v2/library/changes': feed(book('b1', 'f1')),
    'GET /me/v2/annotations/changes': feed(...annotations),
    ...Object.fromEntries(Object.entries(puts).map(([id, answers]) => [`PUT /me/v2/annotations/${id}`, answers])),
  } as never)

  it('pushes a new highlight as a create and an edit on the revision it was made from', async () => {
    db.set('new', local('new'))
    db.set('edited', local('edited', { version: 3, base: { version: 3, color: 'pink' }, color: 'blue' }))
    const calls = routes([annotation('edited', { revision: 4 })], {
      new: [{ status: 201, body: annotation('new', { revision: 1 }) }],
      edited: [{ status: 200, body: annotation('edited', { revision: 5, color: 'blue' }) }],
    })

    await syncBookHighlights('b1', true)

    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => [c.path.split('/').pop(), c.body.expectedRevision])).toEqual([['new', null], ['edited', 3]])
    expect(db.get('edited')).toMatchObject({ syncStatus: 'synced', version: 5 })
  })

  it("adopts the server's row on stale_revision, and drops a write the server refuses for its chapter or id", async () => {
    db.set('stale', local('stale', { version: 3 }))
    db.set('gone-chapter', local('gone-chapter'))
    db.set('gone-id', local('gone-id'))
    routes([annotation('stale', { revision: 7 })], {
      stale: [conflict('stale_revision', { current: annotation('stale', { revision: 7, color: 'green' }) })],
      'gone-chapter': [conflict('chapter_not_found')],
      'gone-id': [conflict('not_found', {}, 404)],
    })

    await syncBookHighlights('b1', true)

    expect(db.get('stale')).toMatchObject({ syncStatus: 'synced', color: 'green', version: 7 })
    expect(db.has('gone-chapter')).toBe(false)
    expect(db.has('gone-id')).toBe(false)
  })

  it('a note edit re-sends the stored locator and file after a file replacement (#1139)', async () => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': feed(book('b1', 'f2')),   // the file was replaced since the row was made on f1
      'GET /me/v2/annotations/changes': feed(annotation('n')),
      'PUT /me/v2/annotations/n': [{ status: 200, body: annotation('n', { revision: 4, noteText: 'note' }) }],
    } as never)
    await syncBookHighlights('b1', true)
    db.set('n', { ...db.get('n')!, noteText: 'note', syncStatus: 'pending' })

    await syncBookHighlights('b1', true, undefined, undefined, true)

    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ noteText: 'note', fileId: 'f1', locator: annotation('n').locator })
    expect(db.get('n')).toMatchObject({ syncStatus: 'synced', noteText: 'note' })
  })

  it('an edit V2 refuses as invalid_payload reverts to the server copy and is not retried (#1139)', async () => {
    const migrated = annotation('m', { locator: { version: 1, scheme: 'textstack-anchor-v1', value: { chapterKey: '2-the-woods', prefix: 'before ', exact: 'the quote', suffix: ' after' } } })
    const calls = routes([migrated], { m: [conflict('invalid_payload', {}, 400)] })
    await syncBookHighlights('b1', true)
    db.set('m', { ...db.get('m')!, color: 'blue', syncStatus: 'pending' })

    await syncBookHighlights('b1', true, undefined, undefined, true)
    await syncBookHighlights('b1', true, undefined, undefined, true)

    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect(db.get('m')).toMatchObject({ syncStatus: 'synced', color: 'pink', version: 3 })
    expect(warn).toHaveBeenCalled()
  })

  it('drops a new highlight whose anchor V2 refuses (no offsets) instead of retrying it forever (#1139)', async () => {
    db.set('bad', local('bad', { anchor: bare }))
    const calls = routes([])

    await syncBookHighlights('b1', true)

    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(db.has('bad')).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('pushes without pulling the feed again once the book was pulled', async () => {
    const calls = routes([], { h: [{ status: 201, body: annotation('h', { revision: 1 }) }] })
    await syncBookHighlights('b1', true)
    db.set('h', local('h'))

    await syncBookHighlights('b1', true, undefined, undefined, true)

    expect(calls.filter((c) => c.path === '/me/v2/annotations/changes')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })
})

describe('a highlight sync that outlives a sign-out (v2Store.reset, #1155)', () => {
  beforeEach(async () => {
    db.clear()
    duringDelete = undefined
    fakeApi(V2_ON)
    await startV2Probe()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetV2ForTests()
  })

  const pulls = { 'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0], 'GET /me/v2/annotations/changes': feed(annotation('a1'))[0] }
  const syncUnderReset = (routes: Record<string, Answer>, hold: string, ui?: Parameters<typeof syncBookHighlights>[2]) =>
    resetMidCall(() => v2Store.reset(), routes, () => syncBookHighlights('b1', true, ui), hold)
  const library = feed(book('b1', 'f1'))[0]

  it('keeps no annotations from a feed answered after the reset', async () => {
    await syncUnderReset(pulls, '/annotations/changes')
    expect(v2Store.annotations.size).toBe(0)
    expect(v2Store.pulled.size).toBe(0)
  })

  it('keeps every synced local highlight when the feed is answered after the reset', async () => {
    db.set('mine', local('mine', { syncStatus: 'synced' }))
    await syncUnderReset(pulls, '/annotations/changes')
    expect(db.has('mine')).toBe(true)
  })

  it('hands the reader no highlights from a feed answered after the reset', async () => {
    const onVisible = vi.fn()
    await syncUnderReset(pulls, '/annotations/changes', { isCancelled: () => false, onVisible, onReplaced: vi.fn() })
    expect(onVisible).not.toHaveBeenCalled()
  })

  it("keeps no annotations when the reset lands during the book's lookup", async () => {
    await syncUnderReset(pulls, '/library/changes')
    expect(v2Store.annotations.size).toBe(0)
  })

  it('stops pruning local highlights when the reset lands during a delete', async () => {
    db.set('r1', local('r1', { syncStatus: 'synced' }))
    db.set('r2', local('r2', { syncStatus: 'synced' }))
    asFake({ 'GET /me/v2/library/changes': library, 'GET /me/v2/annotations/changes': feed()[0] })
    duringDelete = () => v2Store.reset()
    await syncBookHighlights('b1', true)
    expect([...db.keys()]).toEqual(['r2'])
  })

  it("sends no write once the reset landed during the previous row's local delete", async () => {
    db.set('x', local('x', { deleted: true }))
    db.set('new', local('new'))
    const calls = asFake({
      'GET /me/v2/library/changes': library,
      'GET /me/v2/annotations/changes': feed()[0],
      'PUT /me/v2/annotations/new': { status: 201, body: annotation('new', { revision: 1 }) },
    })
    duringDelete = () => v2Store.reset()
    await syncBookHighlights('b1', true)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  it('keeps the annotations of a feed answered with no reset', async () => {
    asFake(pulls)
    await syncBookHighlights('b1', true)
    expect([...v2Store.annotations.keys()]).toEqual(['a1'])
  })

  it('adopts no write answered after the reset: the highlight stays pending', async () => {
    db.set('new', local('new'))
    await syncUnderReset({ ...pulls, 'PUT /me/v2/annotations/new': { status: 201, body: annotation('new', { revision: 1 }) } }, '/annotations/new')
    expect(v2Store.annotations.has('new')).toBe(false)
    expect(db.get('new')).toMatchObject({ syncStatus: 'pending' })
  })

  it('adopts a write answered with no reset', async () => {
    db.set('new', local('new'))
    asFake({ ...pulls, 'PUT /me/v2/annotations/new': { status: 201, body: annotation('new', { revision: 1 }) } })
    await syncBookHighlights('b1', true)
    expect(v2Store.annotations.has('new')).toBe(true)
    expect(db.get('new')).toMatchObject({ syncStatus: 'synced' })
  })

  it('keeps a highlight whose write failed after the reset (a 404 there is not this account\'s answer)', async () => {
    db.set('gone', local('gone'))
    await syncUnderReset({ ...pulls, 'PUT /me/v2/annotations/gone': conflict('not_found', {}, 404) }, '/annotations/gone')
    expect(db.get('gone')).toMatchObject({ syncStatus: 'pending' })
  })
})
