// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { clearSelectionJs } from './readerSelectionJs'
import { openEnginePage, HELD_MS, SETTLED_MS } from '../test/enginePage'

/** QA-007 SEL-1: RN's real clearSelectionJs injected into the real engine page; the close paths' wiring is pinned in the source. */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('clearSelectionJs on the engine page', () => {
  // A test that fails on fake timers must not leave them to the next one (selPage switches back for each open).
  afterEach(() => { vi.useRealTimers() })

  const SEL_CHAPTER = '<p>alpha beta</p><p>gamma delta</p>'
  async function selPage(html = SEL_CHAPTER) {
    vi.useRealTimers()   // the open settles on real time (a test may open a second page)
    const page = await openEnginePage(html)
    vi.useFakeTimers()   // then the hold / settle windows: the page's timers are jsdom's, which call the global setTimeout
    const [p, q] = Array.from(page.root.querySelectorAll('p'))
    const selections = () => page.messages.filter((m) => m.type === 'selection') as unknown as { text: string; token?: number }[]
    const wordMarks = () => page.root.querySelectorAll('svg [data-group="selection"]').length
    /** Press and hold on `el` at `offset` of its text (the engine's hold reads the caret there). */
    const hold = async (el: Element, offset: number) => {
      ;(page.w as unknown as { __caret: () => Range }).__caret = () => { const c = page.w.document.createRange(); c.setStart(el.firstChild!, offset); return c }
      el.dispatchEvent(new page.w.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 30, clientY: 310 }))
      await vi.advanceTimersByTimeAsync(HELD_MS)
    }
    /** A drag selection over [start, end) of `el`'s text, once it settles; null = collapse it. */
    const drag = async (el: Element | null, start = 0, end = 0) => {
      const sel = page.w.document.getSelection()!
      sel.removeAllRanges()
      if (el) { const r = page.w.document.createRange(); r.setStart(el.firstChild!, start); r.setEnd(el.firstChild!, end); sel.addRange(r) }
      page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
      await vi.advanceTimersByTimeAsync(SETTLED_MS)
    }
    return { ...page, p, q, selections, wordMarks, hold, drag }
  }

  it('QA-007 SEL-1: closing a selection clears the WebView one, never a newer one; highlight keeps it on failure', async () => {
    const page = await selPage()
    await page.drag(page.p, 0, 10) // "alpha beta"
    const older = page.selections().at(-1)!
    await page.drag(page.q, 0, 5) // "gamma" — newer
    const newer = page.selections().at(-1)!
    expect(typeof older.token).toBe('number')
    expect(newer.token).not.toBe(older.token)
    // A late clear for the older selection is ignored…
    page.call(clearSelectionJs(older.token))
    expect(page.w.document.getSelection()!.toString()).toBe('gamma')
    // …the current one's clears it.
    page.call(clearSelectionJs(newer.token))
    expect(page.w.document.getSelection()!.toString()).toBe('')

    // Every close path goes through the one effect that injects the clear with the closed token.
    const actions = read('src/components/reader/useReaderWordActions.ts')
    expect(actions).toMatch(/injectJs\(clearSelectionJs\(closedTokenRef\.current\)\)/)
    // Highlight: the paint script drops the word mark itself; failure keeps the selection.
    expect(read('src/hooks/useReaderHighlights.ts')).toMatch(/injectJs\(`\$\{clearSelectionJs\(selection\.token, true\)\};renderHighlight\(/)
    expect(actions).toMatch(/if \(await createHighlight\([^)]*\)\) closeOwnSelection\(selection\)/)
  })

  it('QA-007 SEL-1: selection tokens are unique across documents — a stale clear from the last chapter never matches', async () => {
    const firstToken = async () => {
      const page = await selPage()
      await page.drag(page.p, 0, 5)
      return page.selections().at(-1)!.token
    }
    const a = await firstToken()
    const b = await firstToken()
    expect(typeof a).toBe('number')
    expect(a).not.toBe(b)
  })

  it('QA-007 SEL-1: the word mark is drawn on the overlay — the chapter text gains no element', async () => {
    const page = await selPage()
    const before = { html: page.p.innerHTML, children: page.p.childNodes.length }
    await page.hold(page.p, 7) // "beta"
    expect(page.selections().at(-1)).toMatchObject({ text: 'beta' })
    expect(page.wordMarks()).toBe(1)
    expect({ html: page.p.innerHTML, children: page.p.childNodes.length }).toEqual(before)
  })

  it('QA-007 SEL-1: closing the mark leaves a highlight in the same paragraph intact', async () => {
    const page = await selPage()
    page.call(`renderHighlight('h1', ${JSON.stringify(JSON.stringify({ prefix: '', exact: 'alpha', suffix: ' beta' }))}, 'yellow', 'alpha')`)
    await page.hold(page.p, 7)
    page.call(clearSelectionJs(page.selections().at(-1)!.token))
    expect(page.wordMarks()).toBe(0)
    expect(page.root.querySelectorAll('svg [data-group="highlight"][data-id="h1"]').length).toBe(1)
  })

  it('QA-007 SEL-1: a mark-only clear (before a highlight paints) drops the word mark but keeps the selection, so a failed save can retry', async () => {
    const page = await selPage()
    await page.hold(page.p, 7)
    page.call(clearSelectionJs(page.selections().at(-1)!.token, true))
    expect(page.wordMarks()).toBe(0)
    await page.drag(page.q, 0, 5) // "gamma"
    const sent = page.selections().length
    page.call(clearSelectionJs(page.selections().at(-1)!.token, true))
    expect(page.w.document.getSelection()!.toString()).toBe('gamma')
    await vi.advanceTimersByTimeAsync(SETTLED_MS)
    expect(page.selections()).toHaveLength(sent) // nothing posted: RN's toolbar stays
    // The full clear still ends it.
    page.call(clearSelectionJs(page.selections().at(-1)!.token))
    expect(page.w.document.getSelection()!.toString()).toBe('')
  })

  it('QA-007 SEL-1: holding a second word moves the mark', async () => {
    const page = await selPage()
    await page.hold(page.p, 7)
    await page.hold(page.q, 2)
    expect(page.selections().at(-1)).toMatchObject({ text: 'gamma' })
    expect(page.wordMarks()).toBe(1)
  })

  it('QA-007 SEL-1: a stale clear leaves the newer mark; a mark-only clear with no token is a no-op', async () => {
    const page = await selPage()
    await page.hold(page.p, 7)
    const older = page.selections().at(-1)!.token
    await page.hold(page.q, 2)
    page.call(clearSelectionJs(older))
    expect(page.wordMarks()).toBe(1)
    expect(clearSelectionJs(undefined, true)).toBe('')
  })

  it('QA-007 SEL-1: a word marked inside a highlight — a tap on it still opens the highlight (the mark is never hit-tested)', async () => {
    const page = await selPage('<p>She sat in the garden and watched the moon.</p>')
    // No layout in jsdom: every range sits on the same rect, as a word inside its highlight does.
    const rect = { x: 20, y: 300, left: 20, top: 300, right: 80, bottom: 320, width: 60, height: 20 }
    page.w.Range.prototype.getClientRects = function () { return [rect] as unknown as DOMRectList }
    page.call(`renderHighlight("h1", ${JSON.stringify(JSON.stringify({ prefix: 'She sat in the ', exact: 'garden', suffix: ' and' }))}, "yellow", "garden")`)
    await page.hold(page.p, 17)
    expect(page.selections().at(-1)).toMatchObject({ text: 'garden' })
    const click = () => page.p.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, clientX: 30, clientY: 310 }))
    click()   // the hold's own finger-up: swallowed
    click()
    expect(page.messages.filter(m => m.type === 'highlightTap')).toEqual([{ type: 'highlightTap', highlightId: 'h1' }])
  })

  it('QA-007 SEL-1: a drag selection replaces the word mark, and its collapse ends the selection', async () => {
    const page = await selPage()
    await page.hold(page.p, 7) // "beta" marked
    await page.drag(page.q, 0, 11)
    expect(page.wordMarks()).toBe(0)
    await page.drag(null)
    expect(page.selections().at(-1)).toEqual({ type: 'selection', text: '' })
    expect(page.wordMarks()).toBe(0)
  })
})
