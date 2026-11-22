import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { createVocabulary } from './vocabulary'
import { SessionChangedError } from './sync'
import { forgetPulls } from './sync'
import { fakeApi, card, resetMidCall } from './__tests__/fakeSyncApi'
import type { Word } from './sync'

const API = 'http://api'

describe('the shared V2 vocabulary', () => {
  let n = 0
  const vocab = () => createVocabulary({ newId: () => `id-${++n}`, fileIdOf: async () => null, cards: new Map(), epoch: () => 0 })

  beforeEach(() => {
    forgetPulls()
    initApi({ baseUrl: API, getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('saves an expression intact with its context and returns a normal reviewable card', async () => {
    const text = 'take into account'
    const calls = fakeApi({ 'PUT /me/v2/vocabulary/words': [{ status: 201, body: card('phrase', { word: text }) }] }, API)
    const result = await vocab().saveWord({ word: text, language: 'en', translation: 'учитывать', sentence: 'We must take into account the weather.', bookTitle: 'A book' })
    const request = calls.find(x => x.method === 'PUT')!.body
    expect(request.word).toBe(text)
    expect(request.translation).toBe('учитывать')
    expect(request.example).toMatchObject({ sentence: 'We must take into account the weather.', bookTitle: 'A book' })
    expect(result.word?.word).toBe(text)
  })

  it('rejects oversized selections instead of silently creating a truncated vocabulary entry', async () => {
    const calls = fakeApi({}, API)
    await expect(vocab().saveWord({ word: 'x'.repeat(201), language: 'en' })).rejects.toThrow('200 characters')
    expect(calls).toHaveLength(0)
  })

  it('posts a review answer, and never a practice one (V2 has no practice: a review moves the schedule)', async () => {
    const due = card('w1', { stage: 2, intervalDays: 3, word: 'take into account' })
    const calls = fakeApi({
      'GET /me/v2/vocabulary/due': [{ status: 200, body: [due] }],
      'POST /me/v2/vocabulary/reviews': [{ status: 200, body: { review: { stageBefore: 2, stageAfter: 3 }, word: { ...due, stage: 3 } } }],
    }, API)
    const v = vocab()
    const queue = await v.getReviewQueue(10)
    expect(queue.cards[0].word).toBe('take into account')

    const practice = await v.submitReview({ wordId: 'w1', isCorrect: true, responseTimeMs: 500, isPractice: true })
    expect(practice).toMatchObject({ wordId: 'w1', previousStage: 2, newStage: 2, stageChanged: false, nextIntervalDays: 3 })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)

    const review = await v.submitReview({ wordId: 'w1', isCorrect: true, responseTimeMs: 500, operationId: 'op-1' })
    expect(review).toMatchObject({ previousStage: 2, newStage: 3, stageChanged: true })
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body.operationId)).toEqual(['op-1'])
  })

  // #1151: the app's store reset (cards emptied, epoch bumped) while a read is in flight.
  const session = () => {
    let epoch = 0
    const cards = new Map<string, Word>()
    const v = createVocabulary({ newId: () => 'id', fileIdOf: async () => null, cards, epoch: () => epoch })
    return { v, cards, reset: () => { cards.clear(); epoch++ } }
  }
  const pull = { status: 200, body: { items: [card('w1', { revision: 3 })], cursor: null, hasMore: false } }

  it.each([
    ['the list', (v: ReturnType<typeof createVocabulary>): Promise<unknown> => v.getWords(), { total: 0, items: [] }],
    ['the reader vocab', (v: ReturnType<typeof createVocabulary>): Promise<unknown> => v.getReaderVocab(), []],
    ['the review queue', (v: ReturnType<typeof createVocabulary>): Promise<unknown> => v.getReviewQueue(10, true), { cards: [], totalDue: 0, weeklyProgress: null }],
  ])('%s answered after the reset is empty and remembers nothing', async (_, op, empty) => {
    const { v, cards, reset } = session()
    const routes = { 'GET /vocabulary/due': { status: 200, body: [] }, 'GET /vocabulary/changes': pull }
    expect(await resetMidCall(reset, routes, () => op(v), '/vocabulary/changes')).toEqual(empty)
    expect(cards.size).toBe(0)
  })

  it('a call started after the reset remembers again', async () => {
    const { v, cards, reset } = session()
    reset()
    fakeApi({ 'GET /me/v2/vocabulary/due': [{ status: 200, body: [card('w1', { revision: 3 })] }] }, API)
    await v.getReviewQueue(10)
    expect(cards.get('w1')?.revision).toBe(3)
  })

  // A read before the write (the card's revision) answered after the epoch moved: the write is never sent.
  it.each([
    ['a restore', (v: ReturnType<typeof createVocabulary>) => v.restoreWord('w1')],
    ['an edit', (v: ReturnType<typeof createVocabulary>) => v.updateWord('w1', { translation: 'x' })],
  ])('%s whose card read outlives the epoch sends nothing', async (_, op) => {
    let epoch = 0
    const calls = fakeApi({ 'GET /me/v2/vocabulary/words/w1': [{ status: 200, body: card('w1', { revision: 3 }) }] }, API)
    const fetchOf = globalThis.fetch as unknown as (...a: unknown[]) => Promise<unknown>
    vi.stubGlobal('fetch', async (...a: unknown[]) => { const r = await fetchOf(...a); epoch++; return r })
    const v = createVocabulary({ newId: () => 'id', fileIdOf: async () => null, cards: new Map(), epoch: () => epoch })
    await expect(op(v)).rejects.toBeInstanceOf(SessionChangedError)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
})
