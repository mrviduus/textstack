import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { listDeclinedDownloads, undeclineDownload, updateIdSet, forgetDeclinedDownloads } from './declinedDownloads'
import { applyMergeMap } from './merge'

vi.mock('./sync', () => ({ syncOn: async () => false }))

beforeEach(() => (AsyncStorage as unknown as { __reset(): void }).__reset())

/** An older build's Remove (nothing declines now, #1551). */
const declineDownload = (id: string) => updateIdSet('offline:declined', ids => ids.add(id))

/** `updateIdSet` serialises read-modify-write per key, so overlapping updates all apply (#1174). */
describe('declined downloads', () => {
  it('concurrentDeclineAndUndecline_BothApplied', async () => {
    await declineDownload('a')
    await Promise.all([undeclineDownload('a'), declineDownload('b')])
    expect(await listDeclinedDownloads()).toEqual(new Set(['b']))
  })

  it('updateIdSet_ThrowingChange_RejectsItselfOnly', async () => {
    const failed = updateIdSet('offline:declined', () => { throw new Error('boom') })
    const next = declineDownload('b')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBeUndefined()
    expect(await listDeclinedDownloads()).toEqual(new Set(['b']))
  })

  it('merge_RekeysGuestIds', async () => {
    await declineDownload('guest-b')
    await declineDownload('other')
    await applyMergeMap({ books: { 'guest-b': 'acct-b' }, files: {} })
    expect([...(await listDeclinedDownloads())].sort()).toEqual(['acct-b', 'other'])
  })

  it('forget_QueuedBehindAPendingDecline_Empty', async () => {
    const declining = declineDownload('d1') // not awaited: the forget must not be overtaken by it
    await Promise.all([forgetDeclinedDownloads(), declining])
    expect(await listDeclinedDownloads()).toEqual(new Set())
  })

  it('signOut_DownloadContext_ForgetsTheSet', () => {
    const ctx = readFileSync(resolve(__dirname, '../context/DownloadContext.tsx'), 'utf8')
    const wipe = ctx.slice(ctx.indexOf('if (wasAuthenticatedRef.current && !isAuthenticated) {'), ctx.indexOf('wasAuthenticatedRef.current = isAuthenticated'))
    expect(wipe).toContain('forgetDeclinedDownloads()')
  })
})
