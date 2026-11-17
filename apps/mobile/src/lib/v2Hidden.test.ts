import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi, readingTrackingApi } from '@textstack/shared'
import { resetV2ForTests, startV2Probe, refusedOnV2, nullIfRefused } from './v2'
import { vocabularyApi } from './vocabularyApi'
import { fakeApi, type Answer } from '../../../../packages/shared/src/api/__tests__/fakeV2Api'

vi.mock('./offlineDb', () => ({ dropReplacedUserBookFiles: async () => [] }))
vi.mock('./originalFileCache', () => ({ deleteOriginal: async () => {} }))

const ON: Record<string, Answer[]> = { 'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 1024 } }] }
const OFF: Record<string, Answer[]> = { 'GET /me/v2/status': [{ status: 404 }] }

// M5 (#1031): features with no V2 storage. Their legacy routes answer 410 on V2; the app never asks.
const HIDDEN: [string, () => Promise<unknown>, string][] = [
  ['getVocabularyStats', () => vocabularyApi.getVocabularyStats(), 'GET /me/vocabulary/stats'],
  ['getVocabularyDailyStats', () => vocabularyApi.getVocabularyDailyStats(), 'GET /me/vocabulary/stats/daily'],
  ['getVocabSettings', () => vocabularyApi.getVocabSettings(), 'GET /me/vocabulary/settings'],
  ['getPendingWords', () => vocabularyApi.getPendingWords(), 'GET /me/vocabulary/pending'],
  ['getLookups', () => vocabularyApi.getLookups(), 'GET /me/vocabulary/lookups'],
  ['markAsKnown', () => vocabularyApi.markAsKnown('w1'), 'PUT /me/vocabulary/words/w1/known'],
  ['reading stats', refusedOnV2('readingStats', () => readingTrackingApi.getStats()), 'GET /me/reading/stats'],
  ['reading pace', refusedOnV2('readingStats', () => readingTrackingApi.getReadingPace()), 'GET /me/reading/pace'],
]

describe('a feature V2 holds no data for (mobile)', () => {
  beforeEach(() => {
    resetV2ForTests()
    initApi({ baseUrl: 'http://localhost:8080', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(HIDDEN)('%s: V2 on, refused with a 410 and no request', async (_name, call) => {
    fakeApi(ON)
    await startV2Probe()
    const calls = fakeApi({})
    await expect(call()).rejects.toMatchObject({ status: 410 })
    expect(calls).toEqual([])
  })

  it.each(HIDDEN)('%s: V2 off, its legacy route as before', async (_name, call, route) => {
    fakeApi(OFF)
    await startV2Probe()
    const calls = fakeApi({ [route]: [{ status: 200, body: {} }] })
    await call().catch(() => null)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([route])
  })

  it('nullIfRefused: a refusal reads as null, any other failure stays one', async () => {
    fakeApi(ON)
    await startV2Probe()
    expect(await vocabularyApi.getVocabularyStats().catch(nullIfRefused)).toBeNull()
    expect(() => nullIfRefused(new Error('boom'))).toThrow('boom')
  })
})
