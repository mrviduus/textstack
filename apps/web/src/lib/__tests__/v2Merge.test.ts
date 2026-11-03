import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StoredHighlight, PendingVocabWord } from '../offlineDb'

const highlights = new Map<string, StoredHighlight>()
const pending = new Map<string, PendingVocabWord>()
vi.mock('../offlineDb', () => ({
  getAllStoredHighlights: async () => [...highlights.values()],
  saveHighlight: async (h: StoredHighlight) => { highlights.set(h.id, h) },
  listPendingVocabWords: async () => [...pending.values()],
  deletePendingVocabWord: async (id: string) => { pending.delete(id) },
  addPendingVocabWord: async (p: PendingVocabWord) => {
    if (pending.has(p.id)) throw new Error('exists')
    pending.set(p.id, p)
  },
}))

import { applyV2MergeMap } from '../v2Merge'

beforeEach(() => {
  highlights.clear()
  pending.clear()
  localStorage.clear()
})

describe('applyV2MergeMap', () => {
  it("re-keys this browser's highlights, queued words, reading records and queued sessions to the account's ids", async () => {
    highlights.set('h1', { id: 'h1', userBookId: 'guest-book' } as StoredHighlight)
    highlights.set('h2', { id: 'h2', userBookId: 'other-book' } as StoredHighlight)
    pending.set('op1', { id: 'op1', word: 'quiver' } as PendingVocabWord)
    localStorage.setItem('userbook.progress.guest-book', '{"chapterSlug":"one"}')
    localStorage.setItem('reader.pdfPage.guest-book', '12')
    localStorage.setItem('reading.pendingSessions', JSON.stringify([{ userBookId: 'guest-book' }, { userBookId: null, editionId: 'e1' }]))

    await applyV2MergeMap({ books: { 'guest-book': 'account-book' }, words: { op1: 'account-word' } })

    expect(highlights.get('h1')!.userBookId).toBe('account-book')
    expect(highlights.get('h2')!.userBookId).toBe('other-book')
    // The queued save keeps its id (its operationId) and lands on the account's card.
    expect(pending.get('op1')).toMatchObject({ id: 'op1', wordId: 'account-word' })
    expect(localStorage.getItem('userbook.progress.account-book')).toBe('{"chapterSlug":"one"}')
    expect(localStorage.getItem('userbook.progress.guest-book')).toBeNull()
    expect(localStorage.getItem('reader.pdfPage.account-book')).toBe('12')
    expect(JSON.parse(localStorage.getItem('reading.pendingSessions')!)).toEqual([{ userBookId: 'account-book' }, { userBookId: null, editionId: 'e1' }])
  })

  it('touches nothing for an empty map', async () => {
    highlights.set('h1', { id: 'h1', userBookId: 'b' } as StoredHighlight)
    await applyV2MergeMap({})
    expect(highlights.get('h1')!.userBookId).toBe('b')
  })
})
