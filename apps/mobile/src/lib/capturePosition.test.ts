import { describe, it, expect } from 'vitest'
import { openEnginePage } from '../test/enginePage'

// #802: on a drama chapter the first probe point is an empty speaker cell. Its caret is the <td>,
// not text, and was counted as the whole chapter: the position was saved at the chapter end.
describe('the reading line on the engine page', () => {
  it('skips a caret on an element and reads the text at the next probe point', async () => {
    const html = '<table><tr><td></td><td>The retriever approaches.</td></tr></table><p>After.</p>'
    const page = await openEnginePage(html, 'ch-15', (doc, x) => {
      const [empty, line] = Array.from(doc.querySelectorAll('#ts-root td'))
      const c = doc.createRange()
      if (x === 24) c.setStart(empty, 0)   // the first probe x (box.left + 24): the empty cell
      else c.setStart(line.firstChild!, 4)
      return c
    })
    const progress = page.messages.filter((m) => m.type === 'progress').at(-1)!
    expect((progress.position as { charOffset: number }).charOffset).toBe(4)
  })
})
