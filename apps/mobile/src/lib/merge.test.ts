import { describe, it, expect, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { applyMergeMap } from './merge'
import { enqueuePendingSession } from './pendingSessions'

vi.mock('./sync', () => ({ syncOn: async () => false }))

describe('a sign-in merge map re-keys the local stores', () => {
  it('moves queued sessions to the account ids', async () => {
    await enqueuePendingSession({ userBookId: 'guest-b', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSeconds: 60, wordsRead: 10, startPercent: 0, endPercent: 0.1 })

    await applyMergeMap({ books: { 'guest-b': 'acct-b' }, files: { 'guest-f': 'acct-f' } })

    expect(JSON.parse((await AsyncStorage.getItem('reading.pendingSessions'))!)[0].userBookId).toBe('acct-b')
  })
})
