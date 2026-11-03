import { describe, it, expect, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { applyV2MergeMap } from './v2Merge'
import { enqueuePendingSession } from './pendingSessions'
import { saveUserBookLocalProgress, getUserBookLocalProgress, setUserBookV2State, getUserBookV2State } from './progressStorage'

const rekeyed = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./offlineDb', () => ({ rekeyCachedUserBooks: rekeyed }))
vi.mock('./v2', () => ({ onV2: async () => false }))

describe('a sign-in merge map re-keys the local stores', () => {
  it('moves progress, the PDF flag and queued sessions to the account ids; drops the guest revision', async () => {
    await saveUserBookLocalProgress('guest-b', { updatedAt: 1, chapterSlug: 'k1', bookPercent: 0.3 })
    await AsyncStorage.setItem('reading.userbook-is-pdf.guest-b', '1')
    await setUserBookV2State('guest-b', { revision: 7, fileId: 'guest-f' })
    await enqueuePendingSession({ userBookId: 'guest-b', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSeconds: 60, wordsRead: 10, startPercent: 0, endPercent: 0.1 })

    await applyV2MergeMap({ books: { 'guest-b': 'acct-b' }, files: { 'guest-f': 'acct-f' } })

    expect(await getUserBookLocalProgress('acct-b')).toMatchObject({ chapterSlug: 'k1', bookPercent: 0.3 })
    expect(await getUserBookLocalProgress('guest-b')).toBeNull()
    expect(await AsyncStorage.getItem('reading.userbook-is-pdf.acct-b')).toBe('1')
    expect(await getUserBookV2State('guest-b')).toBeNull()
    expect(JSON.parse((await AsyncStorage.getItem('reading.pendingSessions'))!)[0].userBookId).toBe('acct-b')
    expect(rekeyed).toHaveBeenCalledWith({ 'guest-b': 'acct-b' }, { 'guest-f': 'acct-f' })
  })
})
