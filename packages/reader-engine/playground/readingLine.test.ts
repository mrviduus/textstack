// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readReadingLine } from './readingLine'

describe('readReadingLine', () => {
  // #802: on a drama chapter the first probe point is an empty speaker cell. Its caret is the <td>,
  // not text, and was counted as the whole chapter: the position was saved at the chapter end.
  it('skips a caret on an element and reads the text at the next probe point', () => {
    const article = document.createElement('div')
    article.innerHTML = '<table><tr><td></td><td>The retriever approaches.</td></tr></table><p>After.</p>'
    document.body.appendChild(article)
    const [empty, line] = Array.from(article.querySelectorAll('td'))
    const doc = document as unknown as { caretPositionFromPoint?: (x: number) => unknown }
    doc.caretPositionFromPoint = (x: number) =>
      x < 100 ? { offsetNode: empty, offset: 0 } : { offsetNode: line.firstChild!, offset: 4 }
    article.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400)
    try {
      expect(readReadingLine(article, 100)?.charOffset).toBe(4)
    } finally {
      delete doc.caretPositionFromPoint
      article.remove()
    }
  })
})
