import { describe, it, expect, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { applyMergeMap } from './merge'
import { enqueuePendingSession } from './pendingSessions'
import { setUserBookSyncState, getUserBookSyncState } from './progressStorage'

vi.mock('./sync', () => ({ syncOn: async () => false }))

describe('a sign-in merge map re-keys the local stores', () => {
  it('moves the PDF flag and queued sessions to the account ids; drops the guest revision', async () => {
    await AsyncStorage.setItem('reading.userbook-is-pdf.guest-b', '1')
    await setUserBookSyncState('guest-b', { revision: 7, fileId: 'guest-f' })
    await enqueuePendingSession({ userBookId: 'guest-b', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSeconds: 60, wordsRead: 10, startPercent: 0, endPercent: 0.1 })

    await applyMergeMap({ books: { 'guest-b': 'acct-b' }, files: { 'guest-f': 'acct-f' } })

    expect(await AsyncStorage.getItem('reading.userbook-is-pdf.acct-b')).toBe('1')
    expect(await getUserBookSyncState('guest-b')).toBeNull()
    expect(JSON.parse((await AsyncStorage.getItem('reading.pendingSessions'))!)[0].userBookId).toBe('acct-b')
  })
})
