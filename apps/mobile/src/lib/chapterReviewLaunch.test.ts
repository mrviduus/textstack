import { describe, it, expect, beforeEach } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { vi } from 'vitest'
import {
  GRANTS_TTL_MS, chapterReviewRoute, loadGrantsCached, loadReviewAssistant, resetGrantsCache, saveReviewAssistant,
} from './chapterReviewLaunch'

beforeEach(() => { (AsyncStorage as unknown as { __reset(): void }).__reset(); resetGrantsCache() })

describe('chapterReviewLaunch', () => {
  it('remembers the pick and ignores junk in storage', async () => {
    expect(await loadReviewAssistant()).toBeNull()
    await saveReviewAssistant('chatgpt')
    expect(await loadReviewAssistant()).toBe('chatgpt')
    await AsyncStorage.setItem('chapterReview.assistant', 'gemini')
    expect(await loadReviewAssistant()).toBeNull()
  })

  it('routes an upload by id and a catalog book by edition id + slug', () => {
    expect(chapterReviewRoute({ userBookId: 'b1' }, 'ch')).toEqual({
      pathname: '/chapter-review', params: { userBookId: 'b1', chapterSlug: 'ch' },
    })
    expect(chapterReviewRoute({ editionId: 'e1', slug: 'dracula' }, 'ch')).toEqual({
      pathname: '/chapter-review', params: { editionId: 'e1', slug: 'dracula', chapterSlug: 'ch' },
    })
  })

  it('grants: one request shared by every button, refetched after the TTL or a reset', async () => {
    const fetch = vi.fn().mockResolvedValue([{ id: 'g', clientName: 'Claude', redirectHost: '', createdAt: '', lastUsedAt: null }])
    await Promise.all([loadGrantsCached(fetch, 0), loadGrantsCached(fetch, 10)])
    expect(fetch).toHaveBeenCalledTimes(1)
    await loadGrantsCached(fetch, GRANTS_TTL_MS + 1)
    expect(fetch).toHaveBeenCalledTimes(2)
    resetGrantsCache()
    await loadGrantsCached(fetch, GRANTS_TTL_MS + 2)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('grants: a failure reads as none connected and is not cached', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('403')).mockResolvedValue([])
    expect(await loadGrantsCached(fetch, 0)).toEqual([])
    await loadGrantsCached(fetch, 1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
