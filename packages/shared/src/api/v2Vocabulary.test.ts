import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { createV2Vocabulary } from './v2Vocabulary'
import { SessionChangedError } from './v2'
import { forgetPulls } from './v2'
import { fakeApi, card } from './__tests__/fakeV2Api'

const API = 'http://api'

describe('the shared V2 vocabulary', () => {
  let n = 0
  const vocab = () => createV2Vocabulary({ newId: () => `id-${++n}`, fileIdOf: async () => null, revisions: new Map() })

  beforeEach(() => {
    forgetPulls()
    initApi({ baseUrl: API, getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts a review answer, and never a practice one (V2 has no practice: a review moves the schedule)', async () => {
    const due = card('w1', { stage: 2, intervalDays: 3 })
    const calls = fakeApi({
      'GET /me/v2/vocabulary/due': [{ status: 200, body: [due] }],
      'POST /me/v2/vocabulary/reviews': [{ status: 200, body: { review: { stageBefore: 2, stageAfter: 3 }, word: { ...due, stage: 3 } } }],
    }, API)
    const v = vocab()
    await v.getV2ReviewQueue(10)

    const practice = await v.submitV2Review({ wordId: 'w1', isCorrect: true, responseTimeMs: 500, isPractice: true })
    expect(practice).toMatchObject({ wordId: 'w1', previousStage: 2, newStage: 2, stageChanged: false, nextIntervalDays: 3 })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)

    const review = await v.submitV2Review({ wordId: 'w1', isCorrect: true, responseTimeMs: 500, operationId: 'op-1' })
    expect(review).toMatchObject({ previousStage: 2, newStage: 3, stageChanged: true })
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body.operationId)).toEqual(['op-1'])
  })

  // #1151: a card answered after the app's store epoch moved (sign-out) is not remembered.
  it('remembers no revision for a card answered after the injected epoch moved', async () => {
    let epoch = 0
    const revisions = new Map<string, number>()
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (epoch === 0) epoch++ // the sign-out lands while the first request is in flight
      return { ok: true, status: 200, text: async () => JSON.stringify([card('w1', { revision: 3 })]) }
    }))
    const v = createV2Vocabulary({ newId: () => 'id', fileIdOf: async () => null, revisions, epoch: () => epoch })
    await v.getV2ReviewQueue(10)
    expect(revisions.size).toBe(0)
    await v.getV2ReviewQueue(10) // a call started in the new epoch remembers
    expect(revisions.get('w1')).toBe(3)
  })

  it('a practice answer after the epoch moved never reports a card seen before it', async () => {
    let epoch = 0
    fakeApi({ 'GET /me/v2/vocabulary/due': [{ status: 200, body: [card('w1', { stage: 2, intervalDays: 3 })] }] }, API)
    const v = createV2Vocabulary({ newId: () => 'id', fileIdOf: async () => null, revisions: new Map(), epoch: () => epoch })
    await v.getV2ReviewQueue(10)
    epoch++
    expect(await v.submitV2Review({ wordId: 'w1', isCorrect: true, responseTimeMs: 1, isPractice: true })).toMatchObject({ previousStage: 0, nextIntervalDays: 0 })
  })

  // A read before the write (the card's revision) answered after the epoch moved: the write is never sent.
  it.each([
    ['a restore', (v: ReturnType<typeof createV2Vocabulary>) => v.restoreV2Word('w1')],
    ['an edit', (v: ReturnType<typeof createV2Vocabulary>) => v.updateV2Word('w1', { translation: 'x' })],
  ])('%s whose card read outlives the epoch sends nothing', async (_, op) => {
    let epoch = 0
    const calls = fakeApi({ 'GET /me/v2/vocabulary/words/w1': [{ status: 200, body: card('w1', { revision: 3 }) }] }, API)
    const fetchOf = globalThis.fetch as unknown as (...a: unknown[]) => Promise<unknown>
    vi.stubGlobal('fetch', async (...a: unknown[]) => { const r = await fetchOf(...a); epoch++; return r })
    const v = createV2Vocabulary({ newId: () => 'id', fileIdOf: async () => null, revisions: new Map(), epoch: () => epoch })
    await expect(op(v)).rejects.toBeInstanceOf(SessionChangedError)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
})
