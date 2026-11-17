import { describe, it, expect, vi, afterEach } from 'vitest'
import { startV2Probe, resetV2ForTests } from '../v2'
import { getGoals, getAchievements, getBookStats, getStats, getDailyStats, getReadingPace, getLibrarySummary } from '../readingTracking'
import { getPendingWords, getLookups, getVocabSettings, getConcepts, getVocabStats, getVocabDailyStats } from '../vocabulary'
import { getHighlightsForReview } from '../userData'
import { getDueReviewQuestions } from '../reviewQuestions'
import { fakeApi, V2_ON } from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetV2ForTests()
})

// M5 (#1031): features with no V2 storage. Their legacy routes answer 410 on V2; the client never asks.
const HIDDEN: [string, () => Promise<unknown>, string][] = [
  ['getGoals', () => getGoals(), 'GET /me/reading/goals'],
  ['getAchievements', () => getAchievements(), 'GET /me/reading/achievements'],
  ['getBookStats', () => getBookStats(), 'GET /me/reading/book-stats'],
  ['getStats', () => getStats(), 'GET /me/reading/stats'],
  ['getDailyStats', () => getDailyStats(), 'GET /me/reading/stats/daily'],
  ['getReadingPace', () => getReadingPace(), 'GET /me/reading/pace'],
  ['getLibrarySummary', () => getLibrarySummary(), 'GET /me/reading/library-summary'],
  ['getPendingWords', () => getPendingWords(), 'GET /me/vocabulary/pending'],
  ['getLookups', () => getLookups(), 'GET /me/vocabulary/lookups'],
  ['getVocabSettings', () => getVocabSettings(), 'GET /me/vocabulary/settings'],
  ['getConcepts', () => getConcepts(), 'GET /me/vocabulary/concepts'],
  ['getVocabStats', () => getVocabStats(), 'GET /me/vocabulary/stats'],
  ['getVocabDailyStats', () => getVocabDailyStats(), 'GET /me/vocabulary/stats/daily'],
  ['getHighlightsForReview', () => getHighlightsForReview(), 'GET /me/highlights/review'],
  ['getDueReviewQuestions', () => getDueReviewQuestions(), 'GET /me/review-questions/due'],
]

describe('a feature V2 holds no data for', () => {
  it.each(HIDDEN)('%s: V2 on, refused with a 410 and no request', async (_name, call) => {
    fakeApi(V2_ON)
    await startV2Probe()
    const calls = fakeApi({})
    await expect(call()).rejects.toMatchObject({ status: 410 })
    expect(calls).toEqual([])
  })

  it.each(HIDDEN)('%s: V2 off, its legacy route as before', async (_name, call, route) => {
    fakeApi({ 'GET /me/v2/status': [{ status: 404 }] })
    await startV2Probe()
    const calls = fakeApi({ [route]: [{ status: 200, body: [] }] })
    await call().catch(() => null)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([route])
  })
})
