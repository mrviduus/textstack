import { createRequire } from 'node:module'
import { buildEngineReaderHtml } from '../lib/readerHtml'
import { HOLD_MS, SELECTION_SETTLE_MS } from '../../../../packages/reader-engine/src/timing'

/** Past the engine's hold (E21) and its selection settle (E20), with a margin for jsdom timers. */
export const HELD_MS = HOLD_MS + 50
export const SETTLED_MS = SELECTION_SETTLE_MS + 40

// jsdom ships no types and mobile has no @types/jsdom; only these two are used.
const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: Window & typeof globalThis }
  VirtualConsole: new () => unknown
}

export type PageMsg = { type: string; [k: string]: unknown }
export type EnginePage = Awaited<ReturnType<typeof openEnginePage>>

/**
 * The real reflow document (`buildEngineReaderHtml`, the engine page bundle) booted in jsdom, its
 * messages to RN recorded. No layout: positions are checked on the emulator (QA-007).
 * `w.__caret` (a test sets it, or `caret` from the open) answers the reading-line / hold caret probe.
 */
export async function openEnginePage(chapterHtml: string, slug = 'ch-1', caret?: (doc: Document, x: number, y: number) => Range | null) {
  const messages: PageMsg[] = []
  const { window: w } = new JSDOM(buildEngineReaderHtml(chapterHtml, undefined, slug), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(win: Window & typeof globalThis & Record<string, unknown>) {
      win.ReactNativeWebView = { postMessage: (s: string) => messages.push(JSON.parse(s)) }
      win.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver
      // jsdom lacks these; every Android WebView has them.
      Object.defineProperty(win.Document.prototype, 'scrollingElement', { get() { return this.documentElement } })
      win.Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList }
      if (caret) (win as unknown as { __caret: (x: number, y: number) => Range | null }).__caret = (x, y) => caret(win.document, x, y)
      win.Document.prototype.caretRangeFromPoint = function (x: number, y: number) {
        const c = (win as unknown as { __caret?: (x: number, y: number) => Range | null }).__caret
        return c ? c(x, y) : null
      }
    },
  })
  const settle = () => new Promise((r) => setTimeout(r, 60))
  await settle()   // the open: fonts, a frame, its ack
  const call = (js: string) => (w as unknown as { eval(s: string): unknown }).eval(js)
  const root = w.document.getElementById('ts-root')!
  return { w, messages, settle, call, root }
}
