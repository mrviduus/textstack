import { describe, expect, it } from 'vitest'
import { decideServerState, type PagePosition, type V2ReadingState } from '@textstack/shared'
import { readRelocate } from './chrome.mjs'
import { createMovedTracker } from './movedTracker.mjs'

/** A page `relocate`, through the host's reader. */
const relocate = (index: number, moved: boolean) => readRelocate({ type: 'relocate', index, sections: 9, fraction: 0.1, cfi: `epubcfi(/6/${index}!/4/${moved ? 2 : 4})`, moved })

/** The opening relocate (the page shows the start before `opened`), then the restore. */
const openedAndRestored = (landed?: number) => {
  const t = createMovedTracker()
  t.open()
  t.relocate(relocate(0, false))
  if (landed != null) t.relocate(relocate(landed, false))
  t.restored()
  return t
}

/** ADR-019 on another device's provably newer place in spine item `index`. */
const decide = (t: ReturnType<typeof createMovedTracker>, index: number) => {
  const local: PagePosition = { cfi: 'epubcfi(/6/2!/4/2/1:0)', quote: 'ours', index: 0, at: Date.parse('2026-11-10T10:00:00Z') }
  const server: V2ReadingState = {
    bookId: 'b', fileId: 'f', currentLocator: { version: 1, scheme: 'epub-cfi', value: `epubcfi(/6/${2 * (index + 1)}!/4/2/1:0)`, quote: 'theirs' },
    bookFraction: 0.5, frontierLocator: null, frontierFraction: null, completedAt: null,
    clientRecordedAt: '2026-11-10T11:00:00.000Z', updatedAt: '2026-11-10T11:00:01Z', revision: 3, resetRevision: null,
  }
  return decideServerState({ local, localFileId: 'f', server, reader: t.reader(), now: Date.parse('2026-11-10T12:00:00Z') })
}

describe('v2 host moved tracker (#1278)', () => {
  it('beforeRestored_NothingApplied_Adopts', () => {
    const t = createMovedTracker()
    t.open()
    t.relocate(relocate(0, false))
    expect(t.reader()).toEqual({ restoreApplied: false, moved: false, index: 0 })
    expect(decide(t, 3)).toBe('adopt')
  })

  it('neverReadBook_BeforeAnyTurn_NotMovedWithAnIndex', () => {
    // The restore navigated nowhere and sent no relocate: the opening one already gave the index.
    const t = openedAndRestored()
    expect(t.reader()).toEqual({ restoreApplied: true, moved: false, index: 0 })
    expect(decide(t, 0)).toBe('move')
  })

  it('neverReadBook_FirstTurn_IsAMove', () => {
    const t = openedAndRestored()
    t.relocate(relocate(0, true))
    expect(t.reader().moved).toBe(true)
    expect(decide(t, 0)).toBe('prompt')
  })

  it('relayoutRelocate_IsNotAMove_AndAMoveSurvivesIt', () => {
    const t = openedAndRestored(2)
    t.relocate(relocate(2, false)) // a resize, a font or flow change: another CFI, `moved: false`
    expect(t.reader()).toEqual({ restoreApplied: true, moved: false, index: 2 })
    expect(decide(t, 2)).toBe('move')
    t.relocate(relocate(2, true))
    t.relocate(relocate(2, false))
    expect(t.reader().moved).toBe(true)
  })

  it('hostMove_PutsTheReaderThere_NotMovedUntilTheyMoveAgain', () => {
    const t = openedAndRestored()
    t.relocate(relocate(1, true))
    t.hostMove() // a sync adopt or move, a taken offer: the page reports its landing as `moved: false`
    t.relocate(relocate(4, false))
    expect(t.reader()).toEqual({ restoreApplied: true, moved: false, index: 4 })
    expect(decide(t, 4)).toBe('move')
    expect(decide(t, 5)).toBe('prompt') // another spine item: asked, moved or not
    t.relocate(relocate(4, true))
    expect(decide(t, 4)).toBe('prompt')
  })

  it('restored_ForgetsWhatTheBookOnScreenDidBeforeIt', () => {
    const t = createMovedTracker()
    t.relocate(relocate(3, true))
    t.restored()
    expect(t.reader()).toEqual({ restoreApplied: true, moved: false, index: 3 })
  })

  it('open_ForgetsThePreviousBook', () => {
    const t = openedAndRestored(2)
    t.relocate(relocate(2, true))
    t.open()
    expect(t.reader()).toEqual({ restoreApplied: false, moved: false, index: null })
  })

  it('malformedRelocate_Dropped_UnknownIndexAsks', () => {
    const t = openedAndRestored(2)
    t.relocate(readRelocate({ type: 'store' }))
    expect(t.reader().index).toBe(2)
    t.relocate(readRelocate({ type: 'relocate', index: 'x', moved: 'yes' }))
    expect(t.reader()).toEqual({ restoreApplied: true, moved: false, index: null })
    expect(decide(t, 2)).toBe('prompt')
  })
})
