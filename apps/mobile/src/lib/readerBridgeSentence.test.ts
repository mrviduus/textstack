// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { READER_SELECTION_BRIDGE } from './readerBridge'

// TR-1: shared with the web extractor test (sentenceExtractor.test.ts) so the two can't drift.
// `tag`: the word's block element (default p); `selectThroughGloss`: the selection ends after the gloss.
type Case = { name: string; text: string; html?: string; tag?: string; selectThroughGloss?: boolean; offset: number; word: string; expected: string }
const cases: Case[] = JSON.parse(
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
function install() {
  if (!installed) { new Function(READER_SELECTION_BRIDGE)(); installed = true }
}
function holdOn(text: Text, offset: number) {
  ;(document as unknown as { caretRangeFromPoint: () => Range }).caretRangeFromPoint = () => {
    const r = document.createRange()
    r.setStart(text, offset)
    return r
  }
  install()
  const ev = new Event('touchstart', { bubbles: true })
  Object.defineProperty(ev, 'changedTouches', { value: [{ clientX: 1, clientY: 1 }] })
  text.parentElement!.dispatchEvent(ev)
  vi.advanceTimersByTime(500)
  return posted.filter((m) => m.type === 'selection').pop()
}

/** A native (drag) selection from `offset` to just after the gloss — the selectionchange path. */
function selectThroughGloss(text: Text, offset: number) {
  install()
  // The bridge is installed once per file and keeps state; each test restarts the fake clock near the
  // real now, so jump past the selection-suppression timestamp a previous test's tap left on the bridge.
  vi.setSystemTime(Date.now() + 3_600_000)
  // A real drag starts from an empty selection; that also resets the bridge's de-dupe of the last text.
  window.getSelection()!.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(300)
  const r = document.createRange()
  r.setStart(text, offset)
  r.setEndAfter(document.querySelector('.vocab-inline-translation')!)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(r)
  document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(300)
  return posted.filter((m) => m.type === 'selection').pop()
}

function para(content: string, tag = 'p') {
  document.body.innerHTML = `<div><${tag}>${content}</${tag}><p>Next paragraph.</p></div>`
  return document.querySelector(tag)!.firstChild as Text
}

describe('TR-1: mobile bridge extractSentence', () => {
  it.each(cases)('TR-1 shared fixture: $name', ({ text, html, tag, selectThroughGloss: viaGloss, offset, word, expected }) => {
    const node = para(html ?? text, tag)
    const msg = viaGloss ? selectThroughGloss(node, offset) : holdOn(node, offset + 1)
    if (!viaGloss) expect(msg?.text).toBe(word)
    expect(msg?.sentence).toBe(expected)
  })
})

describe('TR-1: the selected text itself is gloss-free', () => {
  it('TR-1: a drag selection over a saved word posts the word, not its inline gloss', () => {
    document.body.innerHTML =
      '<div><p>He was <mark data-vocab-mark="true">amiable<span class="vocab-inline-translation">приветливый</span></mark> and kind.</p></div>'
    const text = document.querySelector('p')!.firstChild as Text
    const msg = selectThroughGloss(text, 'He was '.length)
    expect(msg?.text).toBe('amiable')
  })
})
