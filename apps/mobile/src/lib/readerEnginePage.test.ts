import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { buildEngineReaderHtml } from './readerHtml'

/**
 * The engine page (ADR-025 Phase 3) speaks the old page's protocol: RN keeps calling the same
 * `window.__textstack*` functions and reading the same messages, so `useReaderPersistence` and its
 * ADR-019 write gate do not change. These boot the real document in jsdom (no layout: positions are
 * checked on the emulator, QA-007).
 */

const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: Window & typeof globalThis }
  VirtualConsole: new () => unknown
}

const SENTENCE = 'The keeper counted the ships before dawn.'
const CHAPTER = `<p>Opening words of the chapter.</p><p>${SENTENCE}</p><p>The last words.</p>`

type Msg = { type: string; [k: string]: unknown }

async function openPage() {
  const messages: Msg[] = []
  const { window: w } = new JSDOM(buildEngineReaderHtml(CHAPTER, undefined, 'ch-1'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(win: Window & typeof globalThis & Record<string, unknown>) {
      win.ReactNativeWebView = { postMessage: (s: string) => messages.push(JSON.parse(s)) }
      win.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver
      // jsdom lacks these; every Android WebView has them.
      Object.defineProperty(win.Document.prototype, 'scrollingElement', { get() { return this.documentElement } })
      win.Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList }
    },
  })
  const settle = () => new Promise((r) => setTimeout(r, 60))
  await settle()   // the open: fonts, a frame, its ack
  const call = (js: string) => (w as unknown as { eval(s: string): unknown }).eval(js)
  return { w, messages, settle, call }
}

/** A stored reading position (TextPosition v1) at the start of SENTENCE. */
function position(chapterSlug = 'ch-1') {
  const text = `Opening words of the chapter.${SENTENCE}The last words.`
  const at = text.indexOf(SENTENCE)
  const exact = text.slice(at, at + 40)
  return { v: 1, chapterSlug, anchor: { prefix: text.slice(0, at), exact, suffix: text.slice(at + 40), startOffset: at, endOffset: at + 40 }, charOffset: at, chapterFraction: 0.4 }
}

describe('the engine page', () => {
  it('opens the chapter and reports it, then acks a restore with its id before the place it landed on', async () => {
    const page = await openPage()
    expect(page.w.document.getElementById('ts-root')!.textContent).toContain(SENTENCE)
    expect(page.messages.some((m) => m.type === 'progress' && m.chapterSlug === 'ch-1')).toBe(true)

    page.messages.length = 0
    page.call(`__textstackRestoreAnchor(${JSON.stringify(JSON.stringify(position()))}, 7)`)
    await page.settle()
    const [ack, progress] = page.messages
    expect(ack).toMatchObject({ type: 'restored', restoreId: 7 })
    expect(progress).toMatchObject({ type: 'progress', chapterSlug: 'ch-1' })
    expect((progress.position as { anchor: { exact: string } }).anchor.exact.startsWith('The keeper counted')).toBe(true)
  })

  it("acks another chapter's position, or an unreadable one, without moving, and still reports the place (R4)", async () => {
    const page = await openPage()
    for (const [json, id] of [[JSON.stringify(position('ch-9')), 8], ['{not json', 10]] as const) {
      page.messages.length = 0
      page.call(`__textstackRestoreAnchor(${JSON.stringify(json)}, ${id})`)
      await page.settle()
      const sent = page.messages.filter((m) => m.type !== 'log')   // another chapter's also logs the engine's anchor-miss
      expect(sent.map((m) => m.type)).toEqual(['restored', 'progress'])
      expect(sent[0]).toMatchObject({ restoreId: id })
    }
  })

  it('applies a typography change to the open chapter and acks its id', async () => {
    const page = await openPage()
    page.messages.length = 0
    page.call(`__textstackApplyTypography(${JSON.stringify('body{font-size: 24px;}')}, 9)`)
    await page.settle()
    expect(page.w.document.getElementById('ts-typography')!.textContent).toBe('body{font-size: 24px;}')
    expect(page.messages.find((m) => m.type === 'restored')).toMatchObject({ restoreId: 9 })
  })

  it('draws the chapter-end block from RN; its buttons post their action, a tap on the text posts tap', async () => {
    const page = await openPage()
    page.call(`__tsSetChapterEnd(${JSON.stringify({ title: 'End of chapter', next: { label: 'Next chapter', counter: '2 of 9' }, prev: { label: 'Previous' } })})`)
    const doc = page.w.document
    expect(doc.querySelector('.ts-end__title')!.textContent).toBe('End of chapter')

    page.messages.length = 0
    ;(doc.querySelector('.ts-end__next') as HTMLButtonElement).click()
    doc.querySelector('#ts-root p')!.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }))
    expect(page.messages.map((m) => m.type === 'chapterEnd' ? `chapterEnd:${m.action}` : m.type)).toEqual(['chapterEnd:next', 'tap'])
  })
})
