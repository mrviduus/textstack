import { describe, expect, it } from 'vitest'
import { createOpenTracker } from './openTracker.mjs'

const opened = (name: string, sha256 = `${name}-sha`) => ({ type: 'opened', book: { name, sha256 } })

describe('v2 host open tracker (S5 review)', () => {
  it('openedForTheOpenInFlight_Taken_OthersDropped', () => {
    const t = createOpenTracker<string>()
    t.open('a', 'A')
    t.open('b', 'B')
    expect(t.opened(opened('a'))).toBeNull() // A answered while B is in flight: kept aside
    expect(t.opened(opened('b'))).toMatchObject({ open: 'B', dropped: ['A'] })
    expect(t.failed('a')).toBeNull()
  })

  it('newerOpenFails_TheBookKeptOnScreenIsTaken', () => {
    // The page swapped B in, C failed before its swap, then B answered (or answered first): B is taken either way.
    for (const order of ['opened first', 'failed first']) {
      const t = createOpenTracker<string>()
      t.open('b', 'B')
      t.open('c', 'C')
      if (order === 'opened first') {
        expect(t.opened(opened('b'))).toBeNull()
        expect(t.failed('c')).toMatchObject({ failed: 'C', take: { open: 'B', opened: opened('b') } })
      } else {
        expect(t.failed('c')).toEqual({ failed: 'C', take: null })
        expect(t.opened(opened('b'))).toMatchObject({ open: 'B' })
      }
      expect(t.restored({ key: 'b-sha' })).toBe(true)
    }
  })

  it('restored_OnlyForTheBookTakenLast', () => {
    const t = createOpenTracker<string>()
    expect(t.restored({ key: 'a-sha' })).toBe(false)
    t.open('a', 'A')
    t.opened(opened('a'))
    t.open('b', 'B')
    expect(t.restored({ key: 'a-sha' })).toBe(true) // A is still the book read until B is taken
    t.opened(opened('b'))
    expect(t.restored({ key: 'a-sha' })).toBe(false) // a stale answer for A never marks B restored
    expect(t.restored({})).toBe(false)
    expect(t.restored({ key: 'b-sha' })).toBe(true)
  })

  it('answersForUnknownOrSupersededNames_Ignored', () => {
    const t = createOpenTracker<string>()
    t.open('a', 'A')
    expect(t.opened(opened('zzz'))).toBeNull()
    expect(t.failed('zzz')).toBeNull()
    t.opened(opened('a'))
    expect(t.opened(opened('a'))).toBeNull() // a second answer for an open already taken
  })
})
