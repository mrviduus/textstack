import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { createV2Vocabulary } from './v2Vocabulary'
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
})
