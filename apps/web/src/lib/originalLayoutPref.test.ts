import { describe, it, expect, beforeEach } from 'vitest'
import { readPdfPage, writePdfPage, serverResumePage } from './originalLayoutPref'

describe('originalLayoutPref (resume-only PDF page position)', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips the resume page position', () => {
    expect(readPdfPage('book-1')).toBeNull()
    writePdfPage('book-1', 12)
    expect(readPdfPage('book-1')).toBe(12)
    // other books unaffected
    expect(readPdfPage('book-2')).toBeNull()
  })

  it('rejects invalid / non-positive stored pages', () => {
    localStorage.setItem('reader.pdfPage.book-1', 'not-a-number')
    expect(readPdfPage('book-1')).toBeNull()
    localStorage.setItem('reader.pdfPage.book-1', '0')
    expect(readPdfPage('book-1')).toBeNull()
  })
})

// Review #4: the server row was read once at mount and won unconditionally. Read page 5 → 80 in
// Original, switch to reflow and back: the remount reopened at the stale server page 5 and saved it.
describe('serverResumePage — the server page only when provably newer than this device', () => {
  beforeEach(() => localStorage.clear())
  const T = Date.parse('2026-10-05T10:00:00Z')
  const iso = (ms: number) => new Date(ms).toISOString()

  it('this device read on after the row was written → the local page wins (null)', () => {
    const rowAtOpen = { locator: 'page:5', clientUpdatedAt: iso(T) }
    writePdfPage('b', 80, T + 60_000)
    expect(serverResumePage('b', rowAtOpen)).toBeNull()
  })

  it('another device wrote later → its page', () => {
    writePdfPage('b', 80, T)
    expect(serverResumePage('b', { locator: 'page:120', clientUpdatedAt: iso(T + 1) })).toBe(120)
  })

  it("this device's own write echoed back (same stamp) → not newer", () => {
    writePdfPage('b', 80, T)
    expect(serverResumePage('b', { locator: 'page:80', clientUpdatedAt: iso(T) })).toBeNull()
  })

  it('no local page yet (a new device) → the server page', () => {
    expect(serverResumePage('b', { locator: 'page:42', clientUpdatedAt: null })).toBe(42)
  })

  it('not a page locator, or no row → null', () => {
    expect(serverResumePage('b', { locator: 'scroll:ch:10', clientUpdatedAt: iso(T) })).toBeNull()
    expect(serverResumePage('b', null)).toBeNull()
  })
})
