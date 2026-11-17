// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { initApi } from '@textstack/shared'
import { renderHook } from '../test/renderHook'
import { startV2Probe, resetV2ForTests } from '../lib/v2'
import { vocabularyApi } from '../lib/vocabularyApi'
import { readingTrackingApi } from '../lib/readingTrackingApi'
import { highlightsApi } from '../lib/highlightsApi'
import { useQuickStats } from './useQuickStats'
import { loadLibraryTab } from '../lib/catalogApi'
import { fakeApi, feed, book } from '../../../../packages/shared/src/api/__tests__/fakeV2Api'

// The real gates (lib wrappers → lib/v2's probe); only the device IO is stubbed.
vi.mock('../lib/offlineDb', () => ({ dropReplacedUserBookFiles: async () => [] }))
vi.mock('../lib/originalFileCache', () => ({ deleteOriginal: async () => {} }))

afterEach(() => vi.unstubAllGlobals())

// M5 (#1031): features with no V2 storage (owner, 2026-11-16). On V2 their legacy routes answer 410.
const READS: (() => Promise<unknown>)[] = [
  () => readingTrackingApi.getStats(),
  () => readingTrackingApi.getDailyStats(),
  () => readingTrackingApi.getReadingPace(),
  () => readingTrackingApi.getGoals(),
  () => readingTrackingApi.getAchievements(),
  () => readingTrackingApi.getBookStats(),
  () => vocabularyApi.getVocabularyStats(),
  () => vocabularyApi.getVocabularyDailyStats(),
  () => vocabularyApi.getVocabSettings(),
  () => vocabularyApi.getPendingWords(),
  () => vocabularyApi.getLookups(),
  () => vocabularyApi.markAsKnown('w1'),
  () => highlightsApi.getHighlightsForReview(),
]

describe('the features V2 holds no data for (mobile)', () => {
  it('with V2 on, a reader never sees or calls them', async () => {
    initApi({ baseUrl: 'http://localhost:8080', getAccessToken: async () => 't', onUnauthorized: async () => null })
    fakeApi({ 'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 1024 } }] })
    await startV2Probe()
    const calls = fakeApi({})

    for (const read of READS) await expect(read()).rejects.toMatchObject({ status: 410 })
    const reader = renderHook(() => useQuickStats(true), {})
    for (let i = 0; i < 3; i++) await act(async () => {})

    expect(reader.result.current).toBeNull()
    expect(calls).toEqual([])
    reader.unmount()
  })

  // #1374: the catalog shelf and its progress answer 410 on V2; one 410 used to fail the whole tab.
  it('with V2 on, the library tab lists the reader\'s uploads and never calls the catalog routes', async () => {
    resetV2ForTests()
    initApi({ baseUrl: 'http://localhost:8080', getAccessToken: async () => 't', onUnauthorized: async () => null })
    const calls = fakeApi({
      'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 1024 } }],
      'GET /me/v2/library/changes': feed(book('b1', 'f1', { title: 'My upload' })),
      'GET /me/v2/reading/changes': feed(),
      // Reached, these would fail the whole load (only a V2 refusal is empty).
      'GET /me/library': [{ status: 500 }],
      'GET /me/progress': [{ status: 500 }],
    })

    const [catalog, progress, uploads, onV2] = await loadLibraryTab()

    expect(uploads.map((b) => b.title)).toEqual(['My upload'])
    expect([catalog, progress, onV2]).toEqual([[], [], true])
    expect(calls.map((c) => c.path).filter((p) => /^\/me\/(library|progress)/.test(p))).toEqual([])
  })
})
