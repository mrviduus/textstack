import { describe, it, expect, beforeEach } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { chapterReviewRoute, loadReviewAssistant, saveReviewAssistant } from './chapterReviewLaunch'

beforeEach(() => (AsyncStorage as unknown as { __reset(): void }).__reset())

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
})
