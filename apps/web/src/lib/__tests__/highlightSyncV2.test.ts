import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { V2Annotation } from '@textstack/shared'
import type { StoredHighlight, TextAnchor } from '../offlineDb'

// IndexedDB as a map: what the sync reads and writes.
const db = new Map<string, StoredHighlight>()
vi.mock('../offlineDb', () => ({
  getHighlightsForEdition: async () => [],
  getHighlightsForUserBook: async (bookId: string) => [...db.values()].filter((h) => h.userBookId === bookId),
  getAllStoredHighlights: async () => [...db.values()],
  saveHighlight: async (h: StoredHighlight) => { db.set(h.id, h) },
  deleteHighlight: async (id: string) => { db.delete(id) },
}))

import { fromV2Annotation, toV2Write, syncBookHighlights } from '../highlightSync'
import { startV2Probe, resetV2ForTests } from '../../api/v2'
import { fakeApi, V2_ON, book, feed, conflict } from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

const text: TextAnchor = { prefix: 'before ', exact: 'the quote', suffix: ' after', startOffset: 7, endOffset: 16, chapterId: '2-the-woods' }

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
  beforeEach(async () => {
    db.clear()
    fakeApi(V2_ON)
    await startV2Probe()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
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

  it('a recolor of a migrated offset-less row re-sends its stored locator unchanged (#1139)', async () => {
    const migrated = annotation('m', { locator: { version: 1, scheme: 'textstack-anchor-v1', value: { chapterKey: '2-the-woods', prefix: 'before ', exact: 'the quote', suffix: ' after' } } })
    const calls = routes([migrated], { m: [{ status: 200, body: { ...migrated, revision: 4, color: 'blue' } }] })
    await syncBookHighlights('b1', true)
    db.set('m', { ...db.get('m')!, color: 'blue', syncStatus: 'pending' })

    await syncBookHighlights('b1', true, undefined, undefined, true)

    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ color: 'blue', locator: migrated.locator })
    expect(db.get('m')).toMatchObject({ syncStatus: 'synced', version: 4 })
  })

  it('drops a new highlight whose anchor V2 refuses (no offsets) instead of retrying it forever (#1139)', async () => {
    const bare = { prefix: 'before ', exact: 'the quote', suffix: ' after', chapterId: '2-the-woods' } as unknown as TextAnchor
    db.set('bad', local('bad', { anchor: bare }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = routes([])

    await syncBookHighlights('b1', true)

    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(db.has('bad')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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
