import { describe, expect, it } from 'vitest'
import { bookTitle, cleanBookTitle } from './bookTitle'

describe('book titles', () => {
  it('a shadow-library download shows the book, not the file name', () => {
    expect(bookTitle('', 'Infinite jest (David Foster Wallace) (z-library.sk, 1lib.sk, z-lib.sk).epub'))
      .toBe('Infinite jest (David Foster Wallace)')
  })

  it("the book's own title wins over its file name, and is cleaned too", () => {
    expect(bookTitle('Infinite Jest', 'infinite_jest (z-lib.org).epub')).toBe('Infinite Jest')
    expect(bookTitle('Designing Data-Intensive Applications (for ${atlas.author_email})', 'ddia.pdf'))
      .toBe('Designing Data-Intensive Applications')
  })

  it('a file name used as metadata, or no metadata, falls back to a tidy file name', () => {
    expect(bookTitle('the_trial (1).epub', 'the_trial (1).epub')).toBe('the trial')
    expect(bookTitle('Microsoft Word - Notes FINAL.docx copy 5', 'notes.pdf')).toBe('Notes FINAL')
  })

  it('real parentheses survive', () => {
    expect(cleanBookTitle('Learning Node.js (2nd Ed.) (Node.js)')).toBe('Learning Node.js (2nd Ed.) (Node.js)')
    expect(cleanBookTitle('Pro ASP.NET (Vol. 2)')).toBe('Pro ASP.NET (Vol. 2)')
  })
})
