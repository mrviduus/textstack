import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildPdfEngineHtml, buildPdfViewerHtml } from './readerHtml'
import { PDF_JS_SCRIPT } from './pdfViewerScript'

/**
 * The generated engine PDF document (buildPdfEngineHtml: PDF_JS_SCRIPT + PDF_ENGINE_SCRIPT) booted in
 * jsdom with the real legacy pdf.js on the engine's committed 40-page fixture: the bundle runs, finds its
 * root, reads the file by ranges with the bearer token and lands on the bootstrap page. jsdom has no
 * canvas and no layout — pixels, spike check 8 and memory are the device pass.
 */

const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: Window & typeof globalThis }
  VirtualConsole: new () => unknown
}
const FILE = new Uint8Array(readFileSync(resolve(__dirname, '../../../../packages/reader-engine/playground/pdf/fixture.pdf')))

type Win = Window & typeof globalThis & Record<string, unknown>

/** What jsdom lacks and every Android WebView pdf.js runs on has; and no Worker: the inlined worker
 *  installs its handler on the page, and pdf.js runs it there. */
function webView(win: Win, messages: { type: string }[]) {
  win.ReactNativeWebView = { postMessage: (s: string) => messages.push(JSON.parse(s)) }
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(win.Document.prototype, 'scrollingElement', { get() { return this.documentElement } })
  for (const k of ['structuredClone', 'ReadableStream', 'TextEncoder', 'TextDecoder', 'Headers']) if (!(k in win)) win[k] = (globalThis as Record<string, unknown>)[k]
  win.URL.createObjectURL = () => 'blob:worker'
  const run = win.eval as (s: string) => void
  run(PDF_JS_SCRIPT)
  run(win.__TS_PDF_WORKER_SRC as string)
}

describe('the PDF bundles', () => {
  it('opens a real PDF with legacy pdf.js by ranges, with the token, and acks the bootstrap page', async () => {
    const messages: { type: string; [k: string]: unknown }[] = []
    const requests: { range: string; auth: string }[] = []
    const html = buildPdfEngineHtml('https://api.test/me/books/b1/file', 'tok', { initialPage: 3, local: false, safeArea: { top: 0, bottom: 0 } })
    new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'https://api.test/',
      virtualConsole: new VirtualConsole(),
      beforeParse(win: Win) {
        webView(win, messages)
        win.fetch = (async (_url: string, init: { headers: HeadersInit }) => {
          const h = new Headers(init.headers)
          const range = h.get('Range')!
          requests.push({ range, auth: h.get('Authorization')! })
          const [a, b] = range.replace('bytes=', '').split('-').map(Number)
          // The page's own realm: pdf.js checks `instanceof ArrayBuffer`.
          const body = new (win.Uint8Array as typeof Uint8Array)(FILE.slice(a, b + 1)).buffer
          return { status: 206, ok: true, headers: new Headers({ 'Content-Range': `bytes ${a}-${b}/${FILE.length}` }), arrayBuffer: async () => body }
        }) as unknown as typeof fetch
      },
    })
    for (let i = 0; i < 100 && !messages.some((m) => m.type === 'pdfPage' || m.type === 'pdfLoadError'); i++) await new Promise((r) => setTimeout(r, 20))

    expect(messages.filter((m) => m.type !== 'log').slice(0, 2)).toEqual([
      { type: 'pdfReady', numPages: 40 },
      { type: 'pdfPage', page: 3, numPages: 40, jumpId: 0 },
    ])
    expect(requests[0]).toEqual({ range: 'bytes=0-0', auth: 'Bearer tok' })
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((r) => r.auth === 'Bearer tok' && /^bytes=\d+-\d+$/.test(r.range))).toBe(true)
  }, 20000)

  it('the old viewer (flag off) runs on the same shared pdf.js global: it opens the file and says pdfReady', async () => {
    const messages: { type: string; [k: string]: unknown }[] = []
    new JSDOM(buildPdfViewerHtml('https://api.test/me/books/b1/file', 'tok', { initialPage: 3 }), {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'https://api.test/',
      virtualConsole: new VirtualConsole(),
      beforeParse(win: Win) {
        webView(win, messages)
        win.IntersectionObserver = class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver
        // pdf.js streams the URL itself here (no ranges): the whole file, in the page's realm.
        win.fetch = (async () => ({
          ok: true, status: 200, headers: new Headers({ 'Content-Length': String(FILE.length) }),
          body: new ReadableStream({ start(c) { c.enqueue(new (win.Uint8Array as typeof Uint8Array)(FILE)); c.close() } }),
        })) as unknown as typeof fetch
      },
    })
    for (let i = 0; i < 100 && !messages.some((m) => m.type === 'pdfReady' || m.type === 'pdfLoadError'); i++) await new Promise((r) => setTimeout(r, 20))
    expect(messages.filter((m) => m.type === 'pdfReady' || m.type === 'pdfLoadError')[0]).toEqual({ type: 'pdfReady', numPages: 40 })
  }, 20000)
})
