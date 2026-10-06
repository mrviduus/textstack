import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../api/userBooks', () => ({ readUserBookProgress: vi.fn() }))

import { readPdfPage, writePdfPage, serverResumePage, fetchNewerPdfPageFor } from './originalLayoutPref'
import { readUserBookProgress } from '../api/userBooks'

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

  it('round 2 #6: a page written before stamps existed is unknown — never proven older', () => {
    localStorage.setItem('reader.pdfPage.b', '80') // legacy: no stamp
    expect(serverResumePage('b', { locator: 'page:60', clientUpdatedAt: iso(T) })).toBeNull()
    writePdfPage('b', 81, T - 1) // the reader turns a page: now it is stamped and comparable
    expect(serverResumePage('b', { locator: 'page:60', clientUpdatedAt: iso(T) })).toBe(60)
  })
})

describe('round 2 #3: fetchNewerPdfPageFor', () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(readUserBookProgress).mockReset() })
  const sig = () => new AbortController().signal

  it('auth still loading is not an answer (null), and asks nothing', async () => {
    expect(await fetchNewerPdfPageFor('b', { isLoading: true, isAuthenticated: false }, sig())).toBeNull()
    expect(readUserBookProgress).not.toHaveBeenCalled()
  })

  it('signed out → false; no answer → null; answered → page or false', async () => {
    expect(await fetchNewerPdfPageFor('b', { isLoading: false, isAuthenticated: false }, sig())).toBe(false)
    vi.mocked(readUserBookProgress).mockResolvedValueOnce(undefined)
    expect(await fetchNewerPdfPageFor('b', { isLoading: false, isAuthenticated: true }, sig())).toBeNull()
    vi.mocked(readUserBookProgress).mockResolvedValueOnce({ chapterSlug: null, locator: 'page:9', percent: null, updatedAt: null, clientUpdatedAt: '2026-10-05T10:00:00Z' })
    expect(await fetchNewerPdfPageFor('b', { isLoading: false, isAuthenticated: true }, sig())).toBe(9)
    vi.mocked(readUserBookProgress).mockResolvedValueOnce(null)
    expect(await fetchNewerPdfPageFor('b', { isLoading: false, isAuthenticated: true }, sig())).toBe(false)
  })
})
