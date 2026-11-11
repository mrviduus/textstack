import { describe, it, expect } from 'vitest'
import { isPdfPage } from './pdfPagePosition'
import { isFractionOnly } from './fractionPosition'

describe('isPdfPage', () => {
  it('pageNumberAlone_IsAPdfPage', () => {
    for (const p of [{ page: 1 }, { page: 3623, index: 3622, fraction: 1, at: 1 }]) expect(isPdfPage(p), JSON.stringify(p)).toBe(true)
  })

  it('notAPositiveIntOrBesideACfiOrQuote_NotAPdfPage', () => {
    for (const p of [
      null, undefined, 3, {}, { page: 0 }, { page: -1 }, { page: 1.5 }, { page: '3' }, { page: NaN },
      // A CBZ position (entry name beside a CFI) and a page number beside a CFI or a quote.
      { cfi: 'epubcfi(/6/4)', page: 'p1.jpg' }, { cfi: 'epubcfi(/6/4)', page: 3 }, { quote: 'q', page: 3 },
    ]) expect(isPdfPage(p), JSON.stringify(p)).toBe(false)
  })

  it('pdfPage_NeverFractionOnly', () => {
    // A PDF position carries a fraction too: it must never read as a transitional fraction-only one.
    expect(isFractionOnly({ page: 3, fraction: 0.5 })).toBe(false)
  })
})
