import { describe, it, expect, beforeEach, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { hasLocalLeftovers, listLocalLeftovers, markUnlistedLeftovers } from './localLeftovers'
import { listDeletedOnServer } from './deletedOnServer'

const originals = new Set<string>()
vi.mock('./originalFileCache', () => ({ listStoredOriginalIds: async () => new Set(originals) }))

beforeEach(() => {
  (AsyncStorage as unknown as { __reset(): void }).__reset()
  originals.clear()
})

describe('localLeftovers (#1193)', () => {
  it('a stored original is what is left of an upload on the device, its source unknown', async () => {
    originals.add('o')
    expect(Object.fromEntries(await listLocalLeftovers())).toEqual({ o: 'unknown' })
    expect(await hasLocalLeftovers('o')).toBe(true)
    expect(await hasLocalLeftovers('x')).toBe(false)
  })

  it('a listing never marks an original of unknown source deleted', async () => {
    originals.add('gone')
    expect(await markUnlistedLeftovers(new Set(), 'v2', () => false)).toEqual([])
    expect(await listDeletedOnServer()).toEqual(new Set())
  })
})
