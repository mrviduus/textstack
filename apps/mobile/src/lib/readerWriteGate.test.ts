import { describe, it, expect } from 'vitest'
import {
  canPersistPosition,
  restoreGateReduce,
  restoredChapter,
  RESTORE_GATE_INITIAL,
  type ReaderWriteGateInput,
  type RestoreGateState,
} from './readerWriteGate'

const base: ReaderWriteGateInput = {
  enabled: true,
  bookKey: 'edition-1',
  chapterSlug: '2-act-i',
  restoredFor: '2-act-i',
}

describe('canPersistPosition', () => {
  it('allows a write once this chapter has been restored', () => {
    expect(canPersistPosition(base)).toBe(true)
  })

  it('refuses the write that destroyed a reader position', () => {
    // The WebView posts progress on its own `load` event, scrollY 0, before any restore has been
    // injected and with no user action. That message reached the server as
    // `scroll:1-dramatis-personae:0`, percent 0, over a reader who was 10% into chapter two.
    expect(canPersistPosition({ ...base, restoredFor: null })).toBe(false)
  })

  it('refuses a write meant for the chapter just left', () => {
    // Moving on starts a new restore. A single boolean would still be true here and would persist
    // the destination chapter at the top.
    expect(canPersistPosition({ ...base, chapterSlug: '3-act-ii', restoredFor: '2-act-i' })).toBe(false)
  })

  it('opens the gate when there was nothing to restore', () => {
    // A book opened for the first time completes its restore by staying at the top. Treating that
    // as "not restored yet" would mean a first read could never be saved.
    expect(canPersistPosition({ ...base, chapterSlug: 'ch-1', restoredFor: 'ch-1' })).toBe(true)
  })

  it('still refuses when another viewer owns the position', () => {
    // Original-layout PDF: the reflow refs were never written, and writing them destroys a real
    // page locator. This check predates the restore gate and is not replaced by it.
    expect(canPersistPosition({ ...base, enabled: false })).toBe(false)
  })

  it('refuses before the book id resolves', () => {
    expect(canPersistPosition({ ...base, bookKey: null })).toBe(false)
    expect(canPersistPosition({ ...base, chapterSlug: null })).toBe(false)
  })
})

/**
 * The window these cover is the one the first version of this gate missed: a restore is injected
 * into a WebView, the gate opened on the injection, and the scroll had not happened yet. QA opened
 * a book at 45%, pressed back within a second, and the saved position was 0.66% — twice.
 */
describe('restoreGateReduce', () => {
  const entered = restoreGateReduce(RESTORE_GATE_INITIAL, {
    type: 'chapterEntered', chapterSlug: '4-act-iii',
  })
  const issued = restoreGateReduce(entered, { type: 'restoreIssued', restoreId: 7, at: 1_000 })

  it('refuses a write while a restore is in flight', () => {
    // The whole defect in one assertion: asked is not arrived.
    expect(issued.phase).toBe('issued')
    expect(restoredChapter(issued)).toBeNull()
  })

  it('opens when the WebView acknowledges the restore it was given', () => {
    const landed = restoreGateReduce(issued, { type: 'restoreLanded', restoreId: 7 })
    expect(restoredChapter(landed)).toBe('4-act-iii')
  })

  it('ignores an acknowledgement from a restore it did not issue', () => {
    // Leaving a chapter mid-restore and entering another: the old ack must not open the new gate.
    expect(restoreGateReduce(issued, { type: 'restoreLanded', restoreId: 6 })).toBe(issued)
  })

  it('opens on a reported position that is not the top', () => {
    // Stands in for a lost acknowledgement. Wherever the reader is, they are somewhere real.
    const moved = restoreGateReduce(issued, { type: 'positionReported', scrollY: 7488 })
    expect(restoredChapter(moved)).toBe('4-act-iii')
  })

  it('is not opened by the zero the page reports on its own load event', () => {
    // The message that did the damage. It arrives with no user action, before any restore lands.
    expect(restoreGateReduce(issued, { type: 'positionReported', scrollY: 0 })).toBe(issued)
  })

  it('opens on the settle timeout, so a lost restore cannot silence saving for good', () => {
    // Losing the tail of one session is bad; losing every session because one injection went
    // missing is worse. Same escape hatch, same value, as PDF_JUMP_SETTLE_MS.
    const timedOut = restoreGateReduce(issued, { type: 'restoreTimedOut', restoreId: 7 })
    expect(restoredChapter(timedOut)).toBe('4-act-iii')
  })

  it('opens immediately when there was nothing to restore', () => {
    const fresh = restoreGateReduce(entered, { type: 'nothingToRestore' })
    expect(restoredChapter(fresh)).toBe('4-act-iii')
  })

  it('closes again on the next chapter, and keeps the id counter', () => {
    const open = restoreGateReduce(issued, { type: 'restoreLanded', restoreId: 7 })
    const next = restoreGateReduce(open, { type: 'chapterEntered', chapterSlug: '5-act-iv' })
    expect(restoredChapter(next)).toBeNull()
    // Carried over so the chapter just left cannot satisfy the chapter just entered.
    expect(next.restoreId).toBe(7)
  })

  it('returns the same state object when nothing transitions', () => {
    // Dispatched on every scroll message; an unchanged reference is what keeps that free.
    const open: RestoreGateState = restoreGateReduce(issued, { type: 'restoreLanded', restoreId: 7 })
    expect(restoreGateReduce(open, { type: 'positionReported', scrollY: 900 })).toBe(open)
  })

  it('shuts for a typography reflow and reopens only when it lands', () => {
    // A reflow scrolls the document to keep the reader in place, and on the way
    // back that scroll is indistinguishable from the reader's own finger. So it
    // goes through the same machine: an id out, an acknowledgement back. Between
    // the two, whatever the WebView reports is a transient — including the
    // non-zero offsets, which is the difference from a fresh load.
    const open = restoreGateReduce(issued, { type: 'restoreLanded', restoreId: 7 })
    expect(restoredChapter(open)).toBe('4-act-iii')

    const reflowing = restoreGateReduce(open, { type: 'restoreIssued', restoreId: 8, at: 1_000 })
    expect(restoredChapter(reflowing)).toBeNull()

    expect(restoredChapter(restoreGateReduce(reflowing, { type: 'restoreLanded', restoreId: 7 })))
      .toBeNull()  // the previous restore's ack cannot open this one

    expect(restoredChapter(restoreGateReduce(reflowing, { type: 'restoreLanded', restoreId: 8 })))
      .toBe('4-act-iii')
  })
})
