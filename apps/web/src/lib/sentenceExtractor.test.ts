import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractSentence } from './sentenceExtractor'

// TR-1: shared with the mobile bridge test (readerBridgeSentence.test.ts) so the two can't drift.
const cases: Array<{ name: string; text: string; offset: number; word: string; expected: string }> = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../packages/shared/src/text/__fixtures__/sentences.json'), 'utf8'),
)

describe('extractSentence', () => {
  it.each(cases)('TR-1 shared fixture: $name', ({ text, offset, word, expected }) => {
    const container = document.createElement('div')
    const p = document.createElement('p')
    p.textContent = text
    container.appendChild(p)
    const range = document.createRange()
    range.setStart(p.firstChild!, offset)
    range.setEnd(p.firstChild!, offset + word.length)

    expect(extractSentence(range, container)).toBe(expected)
  })
})
