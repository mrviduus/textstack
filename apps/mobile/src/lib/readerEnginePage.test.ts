import { describe, it, expect, vi, afterEach } from 'vitest'
import { openEnginePage, HELD_MS, SETTLED_MS } from '../test/enginePage'

/**
 * The engine page (ADR-025 Phase 3) speaks the protocol the old page spoke: RN keeps calling the same
 * `window.__textstack*` functions and reading the same messages, so `useReaderPersistence` and its
 * ADR-019 write gate do not change. These boot the real document in jsdom (no layout: positions are
 * checked on the emulator, QA-007).
 */

const SENTENCE = 'The keeper counted the ships before dawn.'
const CHAPTER = `<p>Opening words of the chapter.</p><p>${SENTENCE}</p><p>The last words.</p>`

const openPage = () => openEnginePage(CHAPTER)

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
    // R4 bug 4: the ack carries the landing (scrollY, the move baseline), and the landing is always reported.
    expect(ack).toMatchObject({ type: 'restored', restoreId: 7, scrollY: expect.any(Number) })
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

/** The text node holding SENTENCE, and a Range over `word` in it. */
function sentenceRange(page: Awaited<ReturnType<typeof openPage>>, word: string, to = word) {
  const node = [...page.w.document.querySelectorAll('#ts-root p')].find((p) => p.textContent === SENTENCE)!.firstChild!
  const r = page.w.document.createRange()
  r.setStart(node, SENTENCE.indexOf(word))
  r.setEnd(node, SENTENCE.indexOf(to) + to.length)
  return r
}

describe('the engine page: selection and words (Phase 3 slice 3)', () => {
  // The page's timers are jsdom's, which call the global setTimeout: fake timers reach them (not its clock).
  afterEach(() => { vi.useRealTimers() })

  it('a held word posts wordEngage, then a tap-mode selection with its sentence, anchor and token', async () => {
    const page = await openPage()
    const w = page.w as unknown as Window & { __caret: () => Range }
    w.__caret = () => { const r = sentenceRange(page, 'counted'); r.setEnd(r.startContainer, r.startOffset + 2); r.collapse(false); return r }
    page.messages.length = 0
    vi.useFakeTimers()
    const p = page.w.document.querySelector('#ts-root p:nth-child(2)')!
    p.dispatchEvent(new page.w.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 50, clientY: 50 }))
    await vi.advanceTimersByTimeAsync(HELD_MS)   // the hold
    const [engage, sel] = page.messages
    expect(engage).toMatchObject({ type: 'wordEngage' })
    expect(sel).toMatchObject({ type: 'selection', mode: 'tap', text: 'counted', sentence: SENTENCE, tooLong: false })
    expect(sel.anchor).toMatchObject({ exact: 'counted', prefix: expect.stringMatching(/The keeper $/), suffix: expect.stringMatching(/^ the ships/) })
    expect(typeof sel.token).toBe('number')
  })

  it('a drag selection posts drag mode; its collapse posts an empty selection', async () => {
    const page = await openPage()
    page.messages.length = 0
    vi.useFakeTimers()
    const sel = page.w.getSelection()!
    sel.addRange(sentenceRange(page, 'keeper', 'ships'))
    page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(SETTLED_MS)
    expect(page.messages.find((m) => m.type === 'selection')).toMatchObject({ mode: 'drag', text: 'keeper counted the ships' })

    page.messages.length = 0
    sel.removeAllRanges()
    page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(SETTLED_MS)
    expect(page.messages.filter((m) => m.type === 'selection')).toEqual([{ type: 'selection', text: '' }])
  })

  it("__tsClearSelection ends the page's selection, unless a newer one was posted since (SEL-1)", async () => {
    const page = await openPage()
    vi.useFakeTimers()
    const sel = page.w.getSelection()!
    const drag = async (from: string, to: string) => {
      sel.removeAllRanges()
      sel.addRange(sentenceRange(page, from, to))
      page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
      await vi.advanceTimersByTimeAsync(SETTLED_MS)
      return page.messages.filter((m) => m.type === 'selection').at(-1)!.token as number
    }
    const old = await drag('keeper', 'ships')
    await drag('ships', 'dawn')
    page.call(`__tsClearSelection(${old}, false)`)
    expect(sel.isCollapsed).toBe(false)              // stale token: the newer selection stays
    const now = page.messages.filter((m) => m.type === 'selection').at(-1)!.token
    page.call(`__tsClearSelection(${now}, false)`)
    expect(sel.isCollapsed).toBe(true)
  })

  it('an image tap opens the lightbox; an internal link scrolls to its target; an outside one goes to RN', async () => {
    const page = await openPage()
    const doc = page.w.document
    const root = doc.getElementById('ts-root')!.firstElementChild!
    root.insertAdjacentHTML('beforeend', '<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Map"><a href="#fn1">1</a><a href="https://example.com/x">site</a></p><p id="fn1">Note.</p>')
    let scrolled = false
    ;(doc.getElementById('fn1') as HTMLElement).scrollIntoView = () => { scrolled = true }
    page.messages.length = 0
    const click = (el: Element) => { el.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, cancelable: true })) }
    // The double-tap window reads the page's own performance.now(), which fake timers do not reach: step it.
    const realNow = page.w.performance.now.bind(page.w.performance)
    let skew = 0
    page.w.performance.now = () => realNow() + skew
    click(root.querySelector('img')!)
    expect(doc.querySelector('.ts-img-lightbox img')!.getAttribute('alt')).toBe('Map')
    page.call('__closeImageLightbox()')
    skew += 320   // past the double-tap window
    click(root.querySelector('a[href="#fn1"]')!)
    expect(scrolled).toBe(true)
    skew += 320
    click(root.querySelector('a[href^="https"]')!)
    expect(page.messages.filter((m) => m.type !== 'log')).toEqual([{ type: 'openLink', href: 'https://example.com/x' }])
  })
})

describe('the engine page: highlights and vocab (Phase 3 slice 4)', () => {
  const layer = (page: Awaited<ReturnType<typeof openPage>>) => page.w.document.querySelector('#ts-root svg')!
  const anchor = JSON.stringify({ prefix: 'The ', exact: 'keeper counted', suffix: ' the ships' })

  it('renderHighlight draws a highlight, removeHighlight takes it away; an unresolvable one draws nothing', async () => {
    const page = await openPage()
    page.call(`renderHighlight('h1', ${JSON.stringify(anchor)}, 'green', 'keeper counted')`)
    page.call(`renderHighlight('h2', ${JSON.stringify(JSON.stringify({ exact: 'not in this chapter' }))}, 'yellow', '')`)
    expect([...layer(page).querySelectorAll('[data-group="highlight"]')].map((g) => g.getAttribute('data-id'))).toEqual(['h1'])
    page.call(`removeHighlight('h1')`)
    expect(layer(page).querySelector('[data-group="highlight"]')).toBeNull()
  })

  it('markVocabWords underlines saved words; addVocabWord adds one; translations follow setShowInlineTranslations', async () => {
    const page = await openPage()
    page.w.Range.prototype.getClientRects = function () { return [{ left: 0, top: 30, right: 50, bottom: 50, width: 50, height: 20 }] as unknown as DOMRectList }
    const words = () => [...layer(page).querySelectorAll('[data-group="word"]')].map((g) => g.getAttribute('data-id'))
    const gloss = () => layer(page).querySelector('.reader-translation')?.textContent ?? null
    page.call(`markVocabWords(${JSON.stringify({ keeper: { stage: 0, translation: 'охоронець' } })})`)
    expect(words()).toEqual(['keeper'])
    expect(gloss()).toBe('охоронець')   // on by default, like the old page
    page.call(`addVocabWord('Dawn', 2)`)
    expect(words()).toEqual(['keeper', 'dawn'])
    page.call('setShowInlineTranslations(false)')
    expect(gloss()).toBeNull()
  })

  it('a tap on a highlight posts highlightTap with its id, not tap', async () => {
    const page = await openPage()
    // jsdom has no layout: give the highlight's text one line box at the tap.
    page.w.Range.prototype.getClientRects = function () {
      return (this.toString() === 'keeper counted' ? [{ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }] : []) as unknown as DOMRectList
    }
    page.call(`renderHighlight('h1', ${JSON.stringify(anchor)}, 'blue', 'keeper counted')`)
    page.messages.length = 0
    page.w.document.querySelector('#ts-root p')!.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
    expect(page.messages.filter((m) => m.type !== 'log')).toEqual([{ type: 'highlightTap', highlightId: 'h1' }])
  })

  it('__textstackScrollToHighlight moves to the highlight and reports the place', async () => {
    const page = await openPage()
    page.messages.length = 0
    page.call(`__textstackScrollToHighlight(${JSON.stringify(anchor)})`)
    await page.settle()
    const progress = page.messages.find((m) => m.type === 'progress')!
    expect((progress.position as { anchor: { exact: string } }).anchor.exact).toContain('keeper counted')
  })

  it("__textstackScrollToHighlight to text that is not in the chapter does not move (it would land at the top and save it)", async () => {
    const page = await openPage()
    page.messages.length = 0
    page.call(`__textstackScrollToHighlight(${JSON.stringify(JSON.stringify({ exact: 'not in this chapter' }))})`)
    await page.settle()
    expect(page.messages.filter((m) => m.type !== 'log')).toEqual([])
  })

  it('renderHighlight refuses a kind:"pdf" anchor, even with exact text (it would paint a PDF quote into reflow)', async () => {
    const page = await openPage()
    page.call(`renderHighlight('p1', ${JSON.stringify(JSON.stringify({ v: 1, kind: 'pdf', page: 3, rects: [], exact: 'keeper counted' }))}, 'yellow', 'keeper counted')`)
    expect(layer(page).querySelector('[data-group="highlight"]')).toBeNull()
  })

  it('renderHighlight with an anchor that is not JSON draws the highlight from its text', async () => {
    const page = await openPage()
    page.call(`renderHighlight('h3', 'keeper counted', 'pink', 'keeper counted')`)
    expect(layer(page).querySelector('[data-group="highlight"]')!.getAttribute('data-id')).toBe('h3')
  })
})
