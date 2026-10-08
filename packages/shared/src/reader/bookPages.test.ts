import { describe, it, expect } from 'vitest'
import { bookPages } from './bookPages'

describe('bookPages', () => {
  it('bookPages_PdfWithPageCount_ExactRealCount', () => {
    // QA-007: a 15-page PDF with 8250 words showed "~33 pages".
    expect(bookPages({ pageCount: 15, totalWordCount: 8250 })).toEqual({ pages: 15, exact: true })
  })

  it('bookPages_NoPageCount_EstimatesFromWords', () => {
    expect(bookPages({ pageCount: null, totalWordCount: 8250 })).toEqual({ pages: 33, exact: false })
    expect(bookPages({ totalWordCount: 500 })).toEqual({ pages: 2, exact: false })
  })

  it('bookPages_NothingKnown_Null', () => {
    expect(bookPages({ pageCount: null, totalWordCount: null })).toBeNull()
    expect(bookPages({ pageCount: 0, totalWordCount: 0 })).toBeNull()
  })

  it('bookPages_TinyText_AtLeastOnePage', () => {
    expect(bookPages({ totalWordCount: 40 })).toEqual({ pages: 1, exact: false })
  })
})
