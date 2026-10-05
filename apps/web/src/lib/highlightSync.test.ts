import { describe, it, expect } from 'vitest'
import { highlightsApi } from '@textstack/shared'
import type { StoredHighlight } from './offlineDb'
import { planHighlightSync, isLocalHighlightId, replayUpdateBody, rebaseHighlightEdit, booksWithPending } from './highlightSync'

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

  it('a pending edit the server did not touch is queued for PUT, rebased on the server row', () => {
    const edited = h(SERVER_ID, { syncStatus: 'pending', color: 'pink', base: { version: 1, color: 'yellow' } })
    const plan = planHighlightSync([h(SERVER_ID)], [edited])

    expect(plan.update.map((x) => x.color)).toEqual(['pink'])
    expect(plan.store).toEqual([]) // server row must not overwrite the edit in IndexedDB
    expect(plan.visible.map((x) => x.color)).toEqual(['pink'])
  })

  it('a pending edit that lost its conflict leaves the server row in place', () => {
    const edited = h(SERVER_ID, { syncStatus: 'pending', color: 'blue', base: { version: 1, color: 'yellow' } })
    const server = h(SERVER_ID, { color: 'pink', version: 2 })
    const plan = planHighlightSync([server], [edited])

    expect(plan.update).toEqual([])
    expect(plan.store).toEqual([server])
    expect(plan.visible).toEqual([server])
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

// What actually goes over the wire for a replayed offline edit, merged onto `server`.
const wire = (local: StoredHighlight, server: StoredHighlight) => {
  const rebased = rebaseHighlightEdit(local, server)
  return rebased && highlightsApi.updateHighlightBody(replayUpdateBody(rebased))
}
const base = { version: 1, color: 'yellow' as const, noteText: 'orig' }
const synced = h(SERVER_ID, { noteText: 'orig' })
const pending = (over: Partial<StoredHighlight>) => h(SERVER_ID, { syncStatus: 'pending', noteText: 'orig', base, ...over })

describe('offline edit replay (three-way merge against base)', () => {
  it('color: server unchanged since base → local color sent, conditional on the server version', () => {
    expect(wire(pending({ color: 'blue' }), synced)).toEqual({ color: 'blue', version: 1 })
  })

  it('color: changed on the server since base → server kept, nothing sent', () => {
    expect(wire(pending({ color: 'blue' }), h(SERVER_ID, { noteText: 'orig', color: 'pink', version: 2 }))).toBeNull()
  })

  it('note: server unchanged → local note sent; cleared note → removeNote', () => {
    expect(wire(pending({ noteText: 'mine', noteEdited: true }), synced)).toEqual({ noteText: 'mine', version: 1 })
    expect(wire(pending({ noteText: undefined, noteEdited: true }), synced)).toEqual({ removeNote: true, version: 1 })
  })

  it('note: changed on the server since base → server note kept', () => {
    const server = h(SERVER_ID, { noteText: 'theirs', version: 2 })
    expect(wire(pending({ noteText: 'mine', noteEdited: true }), server)).toBeNull()
  })

  it('color and note merge independently: server note change kept, local color still applied', () => {
    const server = h(SERVER_ID, { noteText: 'theirs', version: 2 })
    const rebased = rebaseHighlightEdit(pending({ color: 'blue', noteText: 'mine', noteEdited: true }), server)!
    expect(rebased).toMatchObject({ color: 'blue', noteText: 'theirs', noteEdited: false, base: { version: 2, color: 'yellow', noteText: 'theirs' } })
    expect(highlightsApi.updateHighlightBody(replayUpdateBody(rebased))).toEqual({ color: 'blue', version: 2 })
  })

  it('a color-only edit never touches the note (a note added on another device survives)', () => {
    const server = h(SERVER_ID, { noteText: 'added elsewhere', version: 2 })
    expect(wire(pending({ color: 'blue', noteText: 'orig' }), server)).toEqual({ color: 'blue', version: 2 })
  })

  it('legacy pending row without base: local wins (pre-merge behaviour)', () => {
    expect(wire(h(SERVER_ID, { syncStatus: 'pending', color: 'blue' }), h(SERVER_ID, { color: 'pink', version: 3 }))).toEqual({ color: 'blue', version: 3 })
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
