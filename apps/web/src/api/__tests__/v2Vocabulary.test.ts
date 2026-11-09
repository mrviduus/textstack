import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { saveWord, updateWord, getReviewQueue, submitReview, restoreWord, deleteAllWords } from '../vocabulary'
import { startV2Probe, resetV2ForTests, v2Store } from '../v2'
import { fakeApi, V2_ON, feed, card, conflict } from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

afterEach(() => {
  vi.unstubAllGlobals()
  resetV2ForTests()
})

const queued = {
  id: '11111111-1111-4111-8111-111111111111', operationId: '11111111-1111-4111-8111-111111111111',
  word: 'quiver', language: 'en', sentence: 'Her voice began to quiver.', userBookId: 'b1', chapterId: '2-the-woods', bookTitle: 'A book',
}
const library = { 'GET /me/v2/library/changes': feed({ id: 'b1', currentFile: { id: 'f1' }, removedAt: null }) }

describe('saveWord', () => {
  it('replays a queued save with the same card id and operation id (V2)', async () => {
    const calls = fakeApi({ ...V2_ON, ...library, 'PUT /me/v2/vocabulary/words': [{ status: 201, body: card('w1') }] })
    await startV2Probe()

    await saveWord(queued)
    await saveWord(queued)

    const saves = calls.filter((c) => c.method === 'PUT')
    expect(saves).toHaveLength(2)
    for (const s of saves) {
      expect(s.body).toMatchObject({
        id: queued.id, language: 'en', word: 'quiver',
        example: { operationId: queued.operationId, sentence: queued.sentence, bookId: 'b1', fileId: 'f1', chapterKey: '2-the-woods', bookTitle: 'A book' },
      })
    }
  })

  it('sends the legacy body unchanged when V2 is off', async () => {
    const calls = fakeApi({ 'GET /me/v2/status': [{ status: 404 }], 'POST /me/vocabulary/words': [{ status: 200, body: { outcome: 'srs', word: null } }] })
    await startV2Probe()

    await saveWord(queued)

    const post = calls.find((c) => c.method === 'POST')!
    expect(post.path).toBe('/me/vocabulary/words')
    expect(post.body).not.toHaveProperty('id')
    expect(post.body).not.toHaveProperty('operationId')
    expect(post.body).toMatchObject({ word: 'quiver', userBookId: 'b1', chapterId: '2-the-woods' })
  })

  it('answers deleted with the tombstone, and the restore names its revision', async () => {
    const tombstone = card('w1', { deletedAt: '2026-11-02T00:00:00Z', revision: 4 })
    const calls = fakeApi({
      ...V2_ON, ...library,
      'PUT /me/v2/vocabulary/words': [conflict('deleted', { current: tombstone })],
      'POST /me/v2/vocabulary/words/w1/restore': [{ status: 200, body: card('w1', { revision: 5 }) }],
    })
    await startV2Probe()

    expect(await saveWord(queued)).toMatchObject({ outcome: 'deleted', word: { id: 'w1' } })
    expect(await restoreWord('w1')).toMatchObject({ id: 'w1' })
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ expectedRevision: 4 })
  })
})

describe('vocabulary edits and review on V2', () => {
  beforeEach(async () => {
    fakeApi(V2_ON)
    await startV2Probe()
  })

  it('an edit that loses to another device is applied once more, on the revision it lost to', async () => {
    const calls = fakeApi({
      'GET /me/v2/vocabulary/words/w1': [{ status: 200, body: card('w1') }],
      'PATCH /me/v2/vocabulary/words/w1': [conflict('stale_revision', { revision: 3, current: card('w1', { revision: 3 }) }), { status: 200, body: card('w1', { revision: 4, translation: 'сагайдак' }) }],
    })

    expect((await updateWord('w1', { translation: 'сагайдак' })).translation).toBe('сагайдак')
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body.expectedRevision)).toEqual([1, 3])
  })

  it('an automatic fill that loses to another device checks again, and stops if that device filled it', async () => {
    const calls = fakeApi({
      'GET /me/v2/vocabulary/words/w1': [{ status: 200, body: card('w1') }],
      'PATCH /me/v2/vocabulary/words/w1': [conflict('stale_revision', { revision: 2, current: card('w1', { translation: 'колчан', revision: 2 }) })],
    })

    expect((await updateWord('w1', { translation: 'сагайдак', onlyIfEmpty: true })).translation).toBe('колчан')
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
  })

  it('reviews as flashcards, and with nothing due offers the cards nearest to due', async () => {
    fakeApi({
      'GET /me/v2/vocabulary/due': [{ status: 200, body: [] }],
      'GET /me/v2/vocabulary/changes': feed(card('w2', { word: 'later', nextReviewAt: '2026-12-01T00:00:00Z' }), card('w3', { word: 'sooner', nextReviewAt: '2026-11-10T00:00:00Z' })),
    })

    const queue = await getReviewQueue(1, true)

    expect(queue.cards.map((c) => [c.word, c.reviewMode])).toEqual([['sooner', 'flashcard']])
    expect(queue.totalDue).toBe(0)
  })

  it("records the answer as given, under the answer's own operation id", async () => {
    const calls = fakeApi({ 'POST /me/v2/vocabulary/reviews': [{ status: 201, body: { review: { stageBefore: 0, stageAfter: 1 }, word: card('w1') } }] })

    await submitReview({ wordId: 'w1', isCorrect: false, responseTimeMs: 1234.6, reviewMode: 'classic', operationId: 'op-1' })

    expect(calls[0].body).toMatchObject({ operationId: 'op-1', wordId: 'w1', isCorrect: false, responseTimeMs: 1235, reviewMode: 'classic' })
  })

  it('deletes all as one DELETE per live card', async () => {
    const calls = fakeApi({
      'GET /me/v2/vocabulary/changes': feed(card('w1'), card('w2'), card('w3', { deletedAt: '2026-11-01T00:00:00Z' })),
      'DELETE /me/v2/vocabulary/words/w1': [{ status: 200, body: card('w1') }],
      'DELETE /me/v2/vocabulary/words/w2': [{ status: 200, body: card('w2') }],
    })

    expect(await deleteAllWords()).toEqual({ deleted: 2 })
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/me/v2/vocabulary/words/w1', '/me/v2/vocabulary/words/w2'])
  })
})

describe('a sign-out mid-call (#1151)', () => {
  it('a review queue answered after v2Store.reset remembers no revision', async () => {
    fakeApi({ ...V2_ON })
    await startV2Probe()
    let answer!: () => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      answer = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify([card('w1')]) })
    })))
    const queue = getReviewQueue(10)
    for (let i = 0; i < 20 && !answer; i++) await new Promise((r) => setTimeout(r, 0))
    v2Store.reset()
    answer()
    await queue
    expect(v2Store.revisions.size).toBe(0)
  })
})
