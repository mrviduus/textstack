import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractSentence } from './sentenceExtractor'

// TR-1: shared with the mobile bridge test (readerBridgeSentence.test.ts) so the two can't drift.
// `tag`: the word's block element (default p); `selectThroughGloss`: the selection ends after the gloss.
type Case = { name: string; text: string; html?: string; tag?: string; selectThroughGloss?: boolean; offset: number; word: string; expected: string }
const cases: Case[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../packages/shared/src/text/__fixtures__/sentences.json'), 'utf8'),
)

describe('extractSentence', () => {
  it.each(cases)('TR-1 shared fixture: $name', ({ text, html, tag, selectThroughGloss, offset, word, expected }) => {
    const container = document.createElement('div')
    const p = document.createElement(tag ?? 'p')
    if (html) p.innerHTML = html
    else p.textContent = text
    container.appendChild(p)
    const next = document.createElement('p')
    next.textContent = 'Next paragraph.'
    container.appendChild(next)
    const range = document.createRange()
    range.setStart(p.firstChild!, offset)
    if (selectThroughGloss) range.setEndAfter(p.querySelector('.vocab-inline-translation')!)
    else range.setEnd(p.firstChild!, offset + word.length)

    expect(extractSentence(range, container)).toBe(expected)
  })
})
