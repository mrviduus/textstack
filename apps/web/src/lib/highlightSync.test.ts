import { describe, it, expect } from 'vitest'
import type { StoredHighlight } from './offlineDb'
import { booksWithPending } from './highlightSync'

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

describe('booksWithPending', () => {
  it('lists each upload with a pending row once; synced rows and catalog editions are not replayed', () => {
    const books = booksWithPending([
      h('a', { syncStatus: 'pending' }),
      h('c', { editionId: '', userBookId: 'ub-2' }),
      h('d', { editionId: '', userBookId: 'ub-1', syncStatus: 'pending' }),
      h('e', { editionId: '', userBookId: 'ub-1', syncStatus: 'pending', deleted: true }),
    ])
    expect(books).toEqual(['ub-1'])
  })
})
