// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { READER_SELECTION_BRIDGE } from './readerBridge'

// TR-1: shared with the web extractor test (sentenceExtractor.test.ts) so the two can't drift.
const cases: Array<{ name: string; text: string; html?: string; offset: number; word: string; expected: string }> = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../packages/shared/src/text/__fixtures__/sentences.json'), 'utf8'),
)

/** TR-1: the real bridge, driven by a hold, sends the sentence of the TAPPED occurrence. */
let posted: Array<Record<string, unknown>>

beforeEach(() => {
  vi.useFakeTimers()
  posted = []
  ;(window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
    postMessage: (m: string) => posted.push(JSON.parse(m)),
  }
})
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

let installed = false
function holdOn(text: Text, offset: number) {
  ;(document as unknown as { caretRangeFromPoint: () => Range }).caretRangeFromPoint = () => {
    const r = document.createRange()
    r.setStart(text, offset)
    return r
  }
  if (!installed) { new Function(READER_SELECTION_BRIDGE)(); installed = true }
  const ev = new Event('touchstart', { bubbles: true })
  Object.defineProperty(ev, 'changedTouches', { value: [{ clientX: 1, clientY: 1 }] })
  text.parentElement!.dispatchEvent(ev)
  vi.advanceTimersByTime(500)
  return posted.filter((m) => m.type === 'selection').pop()
}

function para(content: string) {
  document.body.innerHTML = `<p>${content}</p>`
  return document.querySelector('p')!.firstChild as Text
}

describe('TR-1: mobile bridge extractSentence', () => {
  it.each(cases)('TR-1 shared fixture: $name', ({ text, html, offset, word, expected }) => {
    const msg = holdOn(para(html ?? text), offset + 1)
    expect(msg?.text).toBe(word)
    expect(msg?.sentence).toBe(expected)
  })
})
