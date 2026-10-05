import { describe, it, expect } from 'vitest'
import { decideNewerPosition, readerMovedSince, serverProvablyNewer } from './progressRestore'

const T = Date.parse('2026-05-01T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('serverProvablyNewer', () => {
  it('no server row → no', () => {
    expect(serverProvablyNewer({ updatedAt: T }, null)).toBe(false)
  })

  it('no local record (new device) → any row is newer', () => {
    expect(serverProvablyNewer(null, { clientUpdatedAt: null })).toBe(true)
  })

  it('client stamp after the local record → yes', () => {
    expect(serverProvablyNewer({ updatedAt: T }, { clientUpdatedAt: iso(T + 1) })).toBe(true)
  })

  it('client stamp at or before the local record → no (the same write, or older)', () => {
    expect(serverProvablyNewer({ updatedAt: T }, { clientUpdatedAt: iso(T) })).toBe(false)
    expect(serverProvablyNewer({ updatedAt: T }, { clientUpdatedAt: iso(T - 1000) })).toBe(false)
  })

  it('never reads the server-clock updatedAt', () => {
    expect(serverProvablyNewer({ updatedAt: T }, { updatedAt: iso(T + 3_600_000), clientUpdatedAt: iso(T - 1) } as never)).toBe(false)
  })

  it('a row without a client stamp is not proof → no', () => {
    expect(serverProvablyNewer({ updatedAt: T }, { clientUpdatedAt: null })).toBe(false)
    expect(serverProvablyNewer({ updatedAt: T }, { clientUpdatedAt: 'garbage' })).toBe(false)
  })
})

describe('decideNewerPosition', () => {
  it('restore not applied yet → adopt as the target', () => {
    expect(decideNewerPosition({ sameChapter: true, restoreApplied: false, readerMoved: false })).toBe('adopt')
  })

  it('applied and the reader has not moved → move silently', () => {
    expect(decideNewerPosition({ sameChapter: true, restoreApplied: true, readerMoved: false })).toBe('move')
  })

  it('the reader has moved → prompt, never yank', () => {
    expect(decideNewerPosition({ sameChapter: true, restoreApplied: true, readerMoved: true })).toBe('prompt')
  })

  it('another chapter → always prompt', () => {
    expect(decideNewerPosition({ sameChapter: false, restoreApplied: false, readerMoved: false })).toBe('prompt')
    expect(decideNewerPosition({ sameChapter: false, restoreApplied: true, readerMoved: false })).toBe('prompt')
  })
})

describe('readerMovedSince', () => {
  it('nothing reported since the restore → not moved', () => {
    expect(readerMovedSince(null, 900, 48)).toBe(false)
  })

  it('within tolerance → not moved; beyond → moved', () => {
    expect(readerMovedSince(1000, 1040, 48)).toBe(false)
    expect(readerMovedSince(1000, 1100, 48)).toBe(true)
  })

  it('pages: any change is a move', () => {
    expect(readerMovedSince(12, 12, 0)).toBe(false)
    expect(readerMovedSince(12, 13, 0)).toBe(true)
  })
})
