import { describe, it, expect, beforeEach, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { listLocalLeftovers, markUnlistedLeftovers } from './localLeftovers'
import { listDeletedOnServer, markDeletedOnServer } from './deletedOnServer'

const rows = new Map<string, boolean>()
const originals = new Set<string>()
vi.mock('./offlineDb', () => ({
  listUserBookCaches: async () => new Map(rows),
  hasAnyUserBookCache: async (id: string) => rows.has(id),
}))
vi.mock('./originalFileCache', () => ({ listStoredOriginalIds: async () => new Set(originals) }))

beforeEach(() => {
  (AsyncStorage as unknown as { __reset(): void }).__reset()
  rows.clear()
  originals.clear()
})

describe('localLeftovers (#1193)', () => {
  it('listLocalLeftovers_RowsAndOriginals_SourcedByRowsElseUnknown', async () => {
    rows.set('v', true).set('l', false)
    originals.add('v').add('o')
    expect(Object.fromEntries(await listLocalLeftovers())).toEqual({ v: 'v2', l: 'legacy', o: 'unknown' })
  })

  it('markUnlistedLeftovers_LegacyListing_MarksOnlyNewLegacyCopies', async () => {
    rows.set('v2-only', true).set('gone', false).set('was', false).set('live', false)
    await markDeletedOnServer('was')
    expect(await markUnlistedLeftovers(new Set(['live']), 'legacy', () => false)).toEqual(['gone'])
    expect([...(await listDeletedOnServer())].sort()).toEqual(['gone', 'was'])
  })

  it('markUnlistedLeftovers_UnknownSource_MarksNothing', async () => {
    rows.set('gone', false)
    expect(await markUnlistedLeftovers(new Set(), null, () => false)).toEqual([])
    expect(await listDeletedOnServer()).toEqual(new Set())
  })

  it('markUnlistedLeftovers_ResetMidway_StopsMarking', async () => {
    rows.set('a', false).set('b', false)
    let calls = 0
    // Fresh at the entry check and before 'a'; reset before 'b'.
    expect(await markUnlistedLeftovers(new Set(), 'legacy', () => ++calls > 2)).toEqual(['a'])
    expect([...(await listDeletedOnServer())]).toEqual(['a'])
  })

  it('markUnlistedLeftovers_StaleAtStart_ReadsNothing', async () => {
    rows.set('a', false)
    expect(await markUnlistedLeftovers(new Set(), 'legacy', () => true)).toEqual([])
  })
})
