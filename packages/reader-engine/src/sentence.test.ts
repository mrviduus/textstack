// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sentenceAround } from './engine'

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
})
