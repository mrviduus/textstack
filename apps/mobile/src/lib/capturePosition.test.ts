import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { buildReaderHtml } from './readerHtml'

const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: Window & typeof globalThis }
  VirtualConsole: new () => unknown
}

// #802: on a drama chapter the first probe point is an empty speaker cell. Its caret is the <td>,
// not text, and was counted as the whole chapter: the position was saved at the chapter end.
describe('__textstackCapturePosition', () => {
  it('skips a caret on an element and reads the text at the next probe point', () => {
    const html = '<table><tr><td></td><td>The retriever approaches.</td></tr></table><p>After.</p>'
    const { window: w } = new JSDOM(buildReaderHtml(html, undefined, 'ch-15'), {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      beforeParse(win: Window & typeof globalThis & { ReactNativeWebView: unknown }) {
        win.ReactNativeWebView = { postMessage: () => {} }
        ;(win.document as unknown as { caretPositionFromPoint: (x: number) => unknown }).caretPositionFromPoint = (x: number) => {
          const [empty, line] = Array.from(win.document.querySelectorAll('td'))
          return x === 24 ? { offsetNode: empty, offset: 0 } : { offsetNode: line.firstChild, offset: 4 }
        }
      },
    })
    const pos = (w as unknown as { __textstackCapturePosition(): { charOffset: number } | null }).__textstackCapturePosition()
    expect(pos?.charOffset).toBe(4)
  })
})
