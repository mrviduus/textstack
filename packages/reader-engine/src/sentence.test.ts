// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blockOf, sentenceAround } from './engine'

/**
 * E48 the sentence a selection carries is the one TR-1 pins for both apps: the shared fixture
 * (`packages/shared/src/text/__fixtures__/sentences.json`), the old web and mobile extractors' contract.
 * Plain-text cases here; the gloss and heading cases need a page: apps/mobile readerSentence.test.ts.
 */
type Case = { name: string; text: string; html?: string; tag?: string; offset: number; word: string; expected: string }
const cases: Case[] = JSON.parse(readFileSync(resolve(__dirname, '../../shared/src/text/__fixtures__/sentences.json'), 'utf8'))

describe('sentence', () => {
  it.each(cases.filter((c) => !c.html && !c.tag))('E48 TR-1 shared fixture: $name', (c) => {
    expect(sentenceAround(c.text, 0, c.text.length, c.offset, c.offset + c.word.length)).toBe(c.expected)
  })

  it('blockOf_XhtmlWithLowerCaseTags_SkipsInlineAncestors', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><div>One <span><em>two</em> three</span> four.</div></body></html>', 'application/xhtml+xml')
    expect(blockOf(doc.querySelector('em')!.firstChild!, doc.body).tagName).toBe('div')
  })
})
