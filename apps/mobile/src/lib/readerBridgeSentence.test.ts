// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READER_SELECTION_BRIDGE } from './readerBridge'

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
  it('TR-1: holding the second "wound" sends its own sentence', () => {
    const src = 'The wound bled. Later she wound the clock.'
    const msg = holdOn(para(src), src.lastIndexOf('wound') + 1)
    expect(msg?.text).toBe('wound')
    expect(msg?.sentence).toBe('Later she wound the clock.')
  })

  it('TR-1: a word past char 500 of a long paragraph is inside the sentence', () => {
    const src = 'Filler sentence number here. '.repeat(25) + 'At last the zephyr arrived.'
    const msg = holdOn(para(src), src.indexOf('zephyr') + 1)
    expect(msg?.text).toBe('zephyr')
    expect(msg?.sentence).toBe('At last the zephyr arrived.')
  })
})
