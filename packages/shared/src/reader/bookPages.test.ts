import { describe, it, expect } from 'vitest'
import { bookPages } from './bookPages'

describe('bookPages', () => {
  it('PDF-2: a stored page count is shown exactly, else the word estimate', () => {
    // QA-007: a 15-page PDF with 8250 words showed "~33 pages".
    expect(bookPages({ pageCount: 15, totalWordCount: 8250 })).toEqual({ pages: 15, exact: true })
    expect(bookPages({ pageCount: null, totalWordCount: 8250 })).toEqual({ pages: 33, exact: false })
    expect(bookPages({ totalWordCount: 40 })).toEqual({ pages: 1, exact: false })
    expect(bookPages({ pageCount: null, totalWordCount: 0 })).toBeNull()
  })
})
