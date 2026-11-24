import { describe, it, expect, beforeEach } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { clearAllLocalProgress } from './progressStorage'

// `__reset` is test-only on the aliased mock.
beforeEach(() => (AsyncStorage as unknown as { __reset(): void }).__reset())

describe('clearAllLocalProgress', () => {
  it('signOut_OlderBuildsProgressRows_AllGoneAndNothingElse', async () => {
    // Progress leaking across accounts on a shared device is a privacy bug,
    // not just a correctness one. Nothing writes these now (#1551); an older build's rows go.
    await AsyncStorage.setItem('reading.progress.ed-1', JSON.stringify({ chapterId: 'c', chapterSlug: 's', percent: 0.4, updatedAt: 1 }))
    await AsyncStorage.setItem('reading.progress.userbook.ub-1', JSON.stringify({ bookPercent: 0.5, updatedAt: 1 }))
    await AsyncStorage.setItem('reading.userbook-is-pdf.ub-1', '1')
    await AsyncStorage.setItem('reading.userbook-v2-state.ub-1', JSON.stringify({ revision: 3, fileId: 'f1' }))
    await AsyncStorage.setItem('textstack-theme', 'dark')

    await clearAllLocalProgress()

    expect(await AsyncStorage.getAllKeys()).toEqual(['textstack-theme'])
  })
})
