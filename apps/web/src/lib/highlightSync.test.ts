import { describe, it, expect } from 'vitest'
import { highlightsApi } from '@textstack/shared'
import type { StoredHighlight } from './offlineDb'
import { planHighlightSync, isLocalHighlightId, replayUpdateBody, booksWithPending } from './highlightSync'

const SERVER_ID = '3f2b8c1e-1111-4a2b-9c3d-000000000001'
const LOCAL_ID = '1759581234567-abc12de'

function h(id: string, over: Partial<StoredHighlight> = {}): StoredHighlight {
  return {
    id,
    editionId: 'ed-1',
    chapterId: 'ch-1',
    anchor: { prefix: 'a', exact: 'word', suffix: 'c', startOffset: 10, endOffset: 14, chapterId: 'ch-1' },
    color: 'yellow',
    selectedText: 'word',
    syncStatus: 'synced',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('isLocalHighlightId', () => {
  it('tells client ids from server GUIDs', () => {
    expect(isLocalHighlightId(LOCAL_ID)).toBe(true)
    expect(isLocalHighlightId(SERVER_ID)).toBe(false)
  })
})

describe('planHighlightSync', () => {
  it('keeps an offline-created highlight visible and queues it for POST', () => {
    const pending = h(LOCAL_ID, { syncStatus: 'pending', createdAt: 5, anchor: { prefix: 'x', exact: 'new', suffix: 'y', startOffset: 50, endOffset: 53, chapterId: 'ch-1' } })
    const plan = planHighlightSync([h(SERVER_ID)], [h(SERVER_ID), pending])

    expect(plan.visible.map((x) => x.id)).toEqual([LOCAL_ID, SERVER_ID])
    expect(plan.create).toEqual([pending])
    expect(plan.drop).toEqual([])
  })

  it('adopts the server twin of a create whose response was lost (no duplicate POST)', () => {
    const pending = h(LOCAL_ID, { syncStatus: 'pending' })
    // Server returns the same anchor with jsonb-reordered keys.
    const server = h(SERVER_ID, { anchor: { chapterId: 'ch-1', endOffset: 14, exact: 'word', prefix: 'a', startOffset: 10, suffix: 'c' } })
    const plan = planHighlightSync([server], [pending])

    expect(plan.create).toEqual([])
    expect(plan.drop).toEqual([LOCAL_ID])
    expect(plan.visible.map((x) => x.id)).toEqual([SERVER_ID])
  })

  it('local pending edit wins over the server row and is queued for PUT', () => {
    const edited = h(SERVER_ID, { syncStatus: 'pending', color: 'pink', version: 2 })
    const plan = planHighlightSync([h(SERVER_ID)], [edited])

    expect(plan.update).toEqual([edited])
    expect(plan.store).toEqual([]) // server row must not overwrite the edit in IndexedDB
    expect(plan.visible).toEqual([edited])
  })

  it('tombstone hides the row and queues a DELETE', () => {
    const plan = planHighlightSync([h(SERVER_ID)], [h(SERVER_ID, { syncStatus: 'pending', deleted: true })])

    expect(plan.remove).toEqual([{ serverId: SERVER_ID, localId: SERVER_ID }])
    expect(plan.visible).toEqual([])
  })

  it('tombstone of a lost-response create deletes its server twin', () => {
    const plan = planHighlightSync([h(SERVER_ID)], [h(LOCAL_ID, { syncStatus: 'pending', deleted: true })])
    expect(plan.remove).toEqual([{ serverId: SERVER_ID, localId: LOCAL_ID }])
    expect(plan.visible).toEqual([])
  })

  it('drops synced rows the server no longer has, and tombstones already gone', () => {
    const plan = planHighlightSync([], [h(SERVER_ID), h(LOCAL_ID, { syncStatus: 'pending', deleted: true })])
    expect(plan.drop).toEqual([SERVER_ID, LOCAL_ID])
    expect(plan.visible).toEqual([])
  })
})

// What actually goes over the wire for a replayed offline edit.
const wire = (x: StoredHighlight) => highlightsApi.updateHighlightBody(replayUpdateBody(x))

describe('replayUpdateBody', () => {
  it('a color-only offline edit leaves the note alone (a note added on another device survives)', () => {
    expect(wire(h(SERVER_ID, { syncStatus: 'pending', color: 'pink', noteText: 'stale local copy' }))).toEqual({ color: 'pink' })
  })

  it('a note cleared offline is sent as removeNote', () => {
    expect(wire(h(SERVER_ID, { syncStatus: 'pending', noteEdited: true }))).toEqual({ color: 'yellow', removeNote: true })
  })

  it('a note edited offline is sent', () => {
    expect(wire(h(SERVER_ID, { syncStatus: 'pending', noteEdited: true, noteText: 'why' }))).toEqual({ color: 'yellow', noteText: 'why' })
  })
})

describe('booksWithPending', () => {
  it('lists each edition / upload with a pending row once, ignoring synced rows', () => {
    const books = booksWithPending([
      h('a', { syncStatus: 'pending' }),
      h('b', { syncStatus: 'pending', deleted: true }),
      h('c', { editionId: 'ed-2' }),
      h('d', { editionId: '', userBookId: 'ub-1', syncStatus: 'pending' }),
    ])
    expect(books).toEqual([
      { bookId: 'ed-1', isUserBook: false },
      { bookId: 'ub-1', isUserBook: true },
    ])
  })
})
