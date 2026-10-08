import { describe, it, expect } from 'vitest'
import { extractSentence } from './sentenceExtractor'

describe('extractSentence', () => {
  it("TR-1: second 'wound' in 'The wound bled. Later she wound the clock.' gives the second sentence", () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>The wound bled. Later she wound the clock.</p>'
    const text = container.querySelector('p')!.firstChild as Text
    const at = text.data.lastIndexOf('wound')
    const range = document.createRange()
    range.setStart(text, at)
    range.setEnd(text, at + 5)

    expect(extractSentence(range, container)).toBe('Later she wound the clock.')
  })
})
