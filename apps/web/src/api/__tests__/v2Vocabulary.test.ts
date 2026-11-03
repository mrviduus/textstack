import { describe, it, expect, vi, afterEach } from 'vitest'
import { saveWord, updateWord, getReviewQueue } from '../vocabulary'
import { startV2Probe, resetV2ForTests } from '../v2'

const card = { id: 'w1', language: 'en', word: 'quiver', translation: null, definition: null, stage: 0, intervalDays: 0,
  consecutiveCorrect: 0, nextReviewAt: '2026-11-02T00:00:00Z', lastReviewedAt: null, createdAt: '2026-11-02T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z', deletedAt: null, retiredAt: null, revision: 1, examples: [] }

/** Records every request; `/me/v2/status` answers `status`, the rest 200 with a card. */
function fakeApi(status: number) {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined })
    const ok = !url.endsWith('/me/v2/status') || status === 200
    const body = url.endsWith('/me/v2/status') ? { maxPartBytes: 1 } : url.includes('/library/changes')
      ? { items: [{ id: 'b1', currentFile: { id: 'f1' }, removedAt: null }], cursor: null, hasMore: false } : card
    return { ok, status: ok ? 200 : status, text: async () => JSON.stringify(body) }
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetV2ForTests()
})

const queued = {
  id: '11111111-1111-4111-8111-111111111111', operationId: '11111111-1111-4111-8111-111111111111',
  word: 'quiver', language: 'en', sentence: 'Her voice began to quiver.', userBookId: 'b1', chapterId: '2-the-woods', bookTitle: 'A book',
}

describe('saveWord on V2', () => {
  it('replays a queued save with the same card id and operation id', async () => {
    const calls = fakeApi(200)
    await startV2Probe()

    await saveWord(queued)
    await saveWord(queued)

    const saves = calls.filter((c) => c.method === 'PUT')
    expect(saves).toHaveLength(2)
    for (const s of saves) {
      expect(s.url).toMatch(/\/me\/v2\/vocabulary\/words$/)
      expect(s.body).toMatchObject({
        id: queued.id, language: 'en', word: 'quiver',
        example: { operationId: queued.operationId, sentence: queued.sentence, bookId: 'b1', fileId: 'f1', chapterKey: '2-the-woods', bookTitle: 'A book' },
      })
    }
  })

  it('sends the legacy body unchanged when V2 is off', async () => {
    const calls = fakeApi(404)
    await startV2Probe()

    await saveWord(queued)

    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toMatch(/\/me\/vocabulary\/words$/)
    expect(post.body).not.toHaveProperty('id')
    expect(post.body).not.toHaveProperty('operationId')
    expect(post.body).toMatchObject({ word: 'quiver', userBookId: 'b1', chapterId: '2-the-woods' })
  })
})

/** Answers by `METHOD path-under-/me/v2` in turn (the last repeating); records each request. */
function routes(map: Record<string, { status: number; body?: unknown }[]>) {
  const calls: { method: string; path: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = url.replace(/^.*\/me\/v2/, '').split('?')[0]
    calls.push({ method, path })
    const queue = map[`${method} ${path}`]
    if (!queue) throw new Error(`unexpected ${method} ${path}`)
    const a = queue.length > 1 ? queue.shift()! : queue[0]
    return { ok: a.status < 300, status: a.status, text: async () => JSON.stringify(a.body ?? {}) }
  }))
  return calls
}

describe('vocabulary edits and review on V2', () => {
  it('an automatic fill that loses to another device checks again, and stops if that device filled it', async () => {
    const theirs = { ...card, translation: 'колчан', revision: 2 }
    const calls = routes({
      'GET /status': [{ status: 200, body: { maxPartBytes: 1 } }],
      'GET /vocabulary/words/w1': [{ status: 200, body: card }],
      'PATCH /vocabulary/words/w1': [{ status: 409, body: { code: 'stale_revision', message: 'x', revision: 2, current: theirs } }],
    })
    await startV2Probe()

    const result = await updateWord('w1', { translation: 'сагайдак', onlyIfEmpty: true })

    expect(result.translation).toBe('колчан')
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
  })

  it('reviews as flashcards, and with nothing due offers the cards nearest to due', async () => {
    const later = { ...card, id: 'w2', word: 'later', nextReviewAt: '2026-12-01T00:00:00Z' }
    const sooner = { ...card, id: 'w3', word: 'sooner', nextReviewAt: '2026-11-10T00:00:00Z' }
    routes({
      'GET /status': [{ status: 200, body: { maxPartBytes: 1 } }],
      'GET /vocabulary/due': [{ status: 200, body: [] }],
      'GET /vocabulary/changes': [{ status: 200, body: { items: [later, sooner], cursor: null, hasMore: false } }],
    })
    await startV2Probe()

    const queue = await getReviewQueue(1, true)

    expect(queue.cards.map((c) => [c.word, c.reviewMode])).toEqual([['sooner', 'flashcard']])
    expect(queue.totalDue).toBe(0)
  })
})
