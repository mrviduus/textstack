// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { heroResumeRoute } from './bookRoutes'
import { downloadLibraryLink } from './downloadLibraryLink'
import { READER_SELECTION_BRIDGE } from './readerBridge'
import { clearSelectionJs } from './readerSelectionJs'

/** QA-007 owner rules. Screens and the WebView aren't drivable here: behaviour where a pure piece exists, source guards for the wiring. */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('QA-007', () => {
  it('LIB-1: Download marks "added by download" only when the Library said not-in-library and the add succeeded', async () => {
    const remove = vi.fn()
    // Known out + add ok → Cancel removes it again.
    let link = downloadLibraryLink(); const add = vi.fn(async () => true)
    link.start('out', add); await link.cancel(remove)
    expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1)
    // Known out + add failed → never removed.
    remove.mockClear(); link = downloadLibraryLink()
    link.start('out', async () => false); await link.cancel(remove)
    expect(remove).not.toHaveBeenCalled()
    // Unknown Library state (getLibrary pending/failed) → added, never removed.
    link = downloadLibraryLink(); const addU = vi.fn(async () => true)
    link.start('unknown', addU); await link.cancel(remove)
    expect(addU).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled()
    // Already in the Library (a hand save) → no add, Cancel leaves it.
    link = downloadLibraryLink(); const addIn = vi.fn(async () => true)
    link.start('in', addIn); await link.cancel(remove)
    expect(addIn).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    // A hand Save/remove after the Download makes the state the reader's own.
    link = downloadLibraryLink(); link.start('out', async () => true); link.forget(); await link.cancel(remove)
    expect(remove).not.toHaveBeenCalled()
  })

  it('LIB-1: Cancel waits for the in-flight add before removing (no reordered POST/DELETE)', async () => {
    const order: string[] = []
    let settle!: (ok: boolean) => void
    const link = downloadLibraryLink()
    link.start('out', () => new Promise<boolean>(r => { settle = ok => { order.push('add'); r(ok) } }))
    const cancelled = link.cancel(() => { order.push('remove') })
    await Promise.resolve()
    expect(order).toEqual([])
    settle(true); await cancelled
    expect(order).toEqual(['add', 'remove'])
  })

  it('LIB-1 wiring: Download/Retry/Restart share one handler; Cancel removes through the Save toggle path; known only from getLibrary', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/onStart=\{onDownload\(\(\) => startDownload\(book, language\)\)\}/)
    expect(src).toMatch(/onRetry=\{onDownload\(\(\) => retryFailed\(book\.id\)\)\}/)
    expect(src).toMatch(/onRestart=\{onDownload\(\(\) => startDownload\(book, language\)\)\}/)
    expect(src).toMatch(/libraryLink\.start\(inLibrary \? 'in' : libraryKnownRef\.current \? 'out' : 'unknown', addToLibrary\)/)
    // Cancel: the same confirm-then-remove the Save toggle uses, after the add settles.
    expect(src).toMatch(/onCancel=\{\(\) => \{\s*cancelDownload\(book\.id\)\s*void libraryLink\.cancel\(removeWithConfirm\)\s*\}\}/)
    expect(src).toMatch(/libraryLink\.forget\(\)\s*if \(!inLibrary\) return addToLibrary\(\)\s*return removeWithConfirm\(\)/)
    expect(src).toMatch(/const removeWithConfirm = async \(\) => \{[\s\S]*?collectionsApi\.listCollections\(\)[\s\S]*?decideLibraryRemoval/)
    // Known only once getLibrary's answer was applied (gen-guarded against local changes in flight).
    expect(src).toMatch(/const gen = libraryGenRef\.current\s*const lib = await libraryApi\.getLibrary\(\)\s*if \(!cancelled && gen === libraryGenRef\.current\) \{\s*libraryKnownRef\.current = true/)
    // The add reports success; failure rolls back.
    expect(src).toMatch(/const addToLibrary = async \(\): Promise<boolean> => \{\s*libraryGenRef\.current\+\+\s*setInLibrary\(true\)[\s\S]*?return true[\s\S]*?setInLibrary\(false\)\s*return false/)
  })

  it('RES-1: hero Continue on a page:N upload opens the reader at the chapter holding the page; lookup failure → detail', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:42', updatedAtMs: 1 }
    const chapters = [
      { slug: 'intro', chapterNumber: 0, sourceStartPage: 1 },
      { slug: null, chapterNumber: 1, sourceStartPage: 30 },
      { slug: 'end', chapterNumber: 2, sourceStartPage: 60 },
    ]
    const none = async () => ({ chapters: [], totalChapters: 0 })
    expect(await heroResumeRoute(pick, { device: none, server: async () => chapters })).toBe('/my-books/read/ub1/chapter-1')
    expect(await heroResumeRoute(pick, { device: none, server: async () => { throw new Error('offline') } })).toBe('/my-books/ub1')
    expect(await heroResumeRoute(pick, { device: async () => { throw new Error('db') }, server: async () => { throw new Error('offline') } })).toBe('/my-books/ub1')
    // No lookup for anything else.
    const load = vi.fn()
    const loaders = { device: load, server: load }
    expect(await heroResumeRoute({ ...pick, chapterSlug: 'intro', locator: null }, loaders)).toBe('/my-books/read/ub1/intro')
    expect(await heroResumeRoute({ ...pick, locator: null }, loaders)).toBe('/my-books/ub1')
    expect(await heroResumeRoute({ type: 'edition', slug: 'dracula', title: 'D', coverPath: null, percent: 0.1, chapterSlug: null, updatedAtMs: 1 }, loaders)).toBe('/book/dracula')
    expect(load).not.toHaveBeenCalled()
    // The PDF reader restores the page itself when Continue opens the chapter holding it.
    expect(read('src/components/reader/useReaderPdf.ts')).toContain('resumePage: originalNewerPage?.page ?? originalResumePage')
    // Repeat taps ignored while the lookup runs (component-local).
    const hero = read('src/components/library/ResumeHero.tsx')
    expect(hero).toMatch(/if \(busyRef\.current\) return/)
    expect(hero).toContain('heroResumeRoute(pick')
  })

  it('RES-1: a page:N locator beats a stale chapterSlug', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.5, chapterSlug: 'ch-2', locator: 'page:300', updatedAtMs: 1 }
    // ch-2 is stale (written earlier in reflow); page 300 lives in chapter 9.
    const chapters = Array.from({ length: 12 }, (_, i) => ({ slug: `ch-${i}`, sourceStartPage: i * 35 + 1 }))
    chapters[9].sourceStartPage = 290 // ch-9: 290..350
    expect(await heroResumeRoute(pick, { device: async () => ({ chapters, totalChapters: 12 }), server: vi.fn() })).toBe('/my-books/read/ub1/ch-9')
  })

  it('RES-1: the device answers first — chapters on the phone open the reader without asking the server', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:42', updatedAtMs: 1 }
    const server = vi.fn(async () => [])
    const device = vi.fn(async () => ({ chapters: [{ slug: 'intro', sourceStartPage: 1 }, { slug: 'chapter-1', sourceStartPage: 30 }], totalChapters: 2 }))
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/chapter-1')
    expect(device).toHaveBeenCalledWith('ub1')
    expect(server).not.toHaveBeenCalled()
    // ResumeHero wires the device loader to SQLite: chapters + the cached book meta's count.
    const hero = read('src/components/library/ResumeHero.tsx')
    expect(hero).toMatch(/listCachedUserChapters\(id\)/)
    expect(hero).toMatch(/getCachedUserBookMeta\(id\)/)
  })

  it('RES-1: a partial device cache is not trusted — the server names the chapter', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:75', updatedAtMs: 1 }
    // Only ch0, ch1 downloaded of 4; page 75 lives in ch3.
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: 20 }], totalChapters: 4 })
    const server = vi.fn(async () => [
      { slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 },
      { slug: 'ch1', chapterNumber: 1, sourceStartPage: 20 },
      { slug: 'ch2', chapterNumber: 2, sourceStartPage: 40 },
      { slug: 'ch3', chapterNumber: 3, sourceStartPage: 70 },
    ])
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch3')
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('RES-1: the server lookup has a 3 s deadline → detail screen; the button shows busy meanwhile', async () => {
    vi.useFakeTimers()
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:75', updatedAtMs: 1 }
    const route = heroResumeRoute(pick, { device: async () => ({ chapters: [], totalChapters: 0 }), server: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await route).toBe('/my-books/ub1')
    vi.useRealTimers()
    const hero = read('src/components/library/ResumeHero.tsx')
    expect(hero).toMatch(/accessibilityState=\{\{ busy \}\}/)
    expect(hero).toMatch(/\{busy \? <ActivityIndicator/)
  })

  it('RES-1: no navigation once the hero has lost focus or unmounted', () => {
    const hero = read('src/components/library/ResumeHero.tsx')
    expect(hero).toMatch(/useFocusEffect\(useCallback\(\(\) => \{\s*focusedRef\.current = true\s*return \(\) => \{ focusedRef\.current = false \}/)
    expect(hero).toMatch(/if \(focusedRef\.current\) router\.push\(route as never\)/)
  })

  it('SEL-1: closing a selection clears the WebView one, never a newer one; highlight keeps it on failure', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<p id="p">alpha beta gamma</p>'
    const posted: { text: string; token?: number }[] = []
    ;(window as any).ReactNativeWebView = { postMessage: (m: string) => { const d = JSON.parse(m); if (d.type === 'selection') posted.push(d) } }
    new Function(READER_SELECTION_BRIDGE)()
    const text = document.getElementById('p')!.firstChild!
    const select = (start: number, end: number) => {
      const r = document.createRange(); r.setStart(text, start); r.setEnd(text, end)
      const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r)
      document.dispatchEvent(new Event('selectionchange')); vi.advanceTimersByTime(300)
    }
    select(0, 10) // "alpha beta"
    const older = posted.at(-1)!
    select(11, 16) // "gamma" — newer
    const newer = posted.at(-1)!
    expect(typeof older.token).toBe('number')
    expect(newer.token).not.toBe(older.token)
    // A late clear for the older selection is ignored…
    new Function(clearSelectionJs(older.token))()
    expect(window.getSelection()!.toString()).toBe('gamma')
    // …the current one's clears it.
    new Function(clearSelectionJs(newer.token))()
    expect(window.getSelection()!.toString()).toBe('')
    vi.useRealTimers()

    // Every close path goes through the one effect that injects the clear with the closed token.
    const actions = read('src/components/reader/useReaderWordActions.ts')
    expect(actions).toMatch(/injectJs\(clearSelectionJs\(closedTokenRef\.current\)\)/)
    // Highlight: the paint script drops the word mark itself; failure keeps the selection.
    expect(read('src/hooks/useReaderHighlights.ts')).toMatch(/injectJs\(`\$\{clearSelectionJs\(selection\.token, true\)\};renderHighlight\(/)
    expect(actions).toMatch(/if \(await createHighlight\([^)]*\)\) closeOwnSelection\(selection\)/)
  })
  it('SEL-1: selection tokens are unique across documents — a stale clear from the last chapter never matches', async () => {
    // @ts-expect-error -- jsdom ships no types and vitest's jsdom env is all we need it for
    const { JSDOM } = await import('jsdom')
    const firstToken = async () => {
      const dom = new JSDOM('<p id="p">alpha beta</p>', { url: 'https://reader.test/', runScripts: 'outside-only' })
      const w = dom.window as any
      const posted: { token?: number }[] = []
      w.ReactNativeWebView = { postMessage: (m: string) => { const d = JSON.parse(m); if (d.type === 'selection' && d.text) posted.push(d) } }
      w.eval(READER_SELECTION_BRIDGE)
      const t = w.document.getElementById('p').firstChild
      const r = w.document.createRange(); r.setStart(t, 0); r.setEnd(t, 5)
      w.getSelection().addRange(r)
      w.document.dispatchEvent(new w.Event('selectionchange'))
      await new Promise(res => setTimeout(res, 300))
      return posted.at(-1)!.token
    }
    const a = await firstToken()
    const b = await firstToken()
    expect(typeof a).toBe('number')
    expect(a).not.toBe(b)
  })

  it('SEL-1: closing the word mark unwraps it and repaints the vocab layer with the current map', async () => {
    // @ts-expect-error -- jsdom ships no types and vitest's jsdom env is all we need it for
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<p id="p">alpha beta gamma</p>', { url: 'https://reader.test/', runScripts: 'outside-only' })
    const w = dom.window as any
    const d = w.document
    const posted: { token?: number }[] = []
    w.ReactNativeWebView = { postMessage: (m: string) => { const x = JSON.parse(m); if (x.type === 'selection' && x.text) posted.push(x) } }
    w.eval(READER_SELECTION_BRIDGE)
    // The reader page's vocab layer (readerHtml): a global map + the paint function.
    const painted: Record<string, unknown>[] = []
    w.__painted = (m: Record<string, unknown>) => painted.push(m)
    w.eval('var _currentVocabMap = {}; function markVocabWords(m) { _currentVocabMap = m; window.__painted(JSON.parse(JSON.stringify(m))) }')
    const p = d.getElementById('p')
    // Hold on "beta": the tap path marks the word it resolves at the point.
    d.caretRangeFromPoint = () => { const c = d.createRange(); c.setStart(p.firstChild, 7); return c }
    const touch = new w.Event('touchstart', { bubbles: true })
    Object.defineProperty(touch, 'changedTouches', { value: [{ clientX: 1, clientY: 1 }] })
    p.dispatchEvent(touch)
    await new Promise(res => setTimeout(res, 500))
    expect(p.querySelector('.ts-word-mark').textContent).toBe('beta')
    // "beta" saved while the mark is up.
    w.eval('_currentVocabMap = { beta: { stage: 0 } }')
    w.eval(clearSelectionJs(posted.at(-1)!.token))
    // No leftover span, text nodes merged back.
    expect(p.querySelector('span')).toBeNull()
    expect(p.childNodes.length).toBe(1)
    // ...and the just-saved word is painted again on the restored text.
    expect(painted.at(-1)).toEqual({ beta: { stage: 0 } })
  })

  /** Real bridge in its own jsdom, a legacy-style vocab painter (rebuilds text nodes) and a press-and-hold helper. */
  async function bridgeDoc() {
    // @ts-expect-error -- jsdom ships no types and vitest's jsdom env is all we need it for
    const { JSDOM } = await import('jsdom')
    // Two paragraphs: jsdom lacks normalize()'s live-Range fixup (Chromium has it), so the second word lives in its own node.
    const dom = new JSDOM('<p id="p">alpha beta</p><p id="q">gamma delta</p>', { url: 'https://reader.test/', runScripts: 'outside-only' })
    const w = dom.window as any
    const d = w.document
    const posted: { token?: number }[] = []
    w.ReactNativeWebView = { postMessage: (m: string) => { const x = JSON.parse(m); if (x.type === 'selection' && x.text) posted.push(x) } }
    w.eval(READER_SELECTION_BRIDGE)
    w.__paints = 0
    // Legacy paint path replaces text nodes (vhlLegacyRemove/Mark) — any Range held across it dies.
    w.eval(`var _currentVocabMap = { alpha: { stage: 0 } }; function markVocabWords(m) { window.__paints++; _currentVocabMap = m;
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), ns = [], n; while (n = w.nextNode()) ns.push(n);
      ns.forEach(function(t) { t.parentNode.replaceChild(document.createTextNode(t.data), t) }) }`)
    const p = d.getElementById('p')
    const q = d.getElementById('q')
    const hold = async (el: HTMLElement, offset: number) => {
      d.caretRangeFromPoint = () => { const c = d.createRange(); c.setStart(el.firstChild!, offset); return c }
      const touch = new w.Event('touchstart', { bubbles: true })
      Object.defineProperty(touch, 'changedTouches', { value: [{ clientX: 1, clientY: 1 }] })
      el.dispatchEvent(touch)
      await new Promise(res => setTimeout(res, 500))
    }
    return { w, d, p, q, posted, hold }
  }

  it('SEL-1: tapping a second word while the first is marked marks the second (no vocab repaint on re-mark)', async () => {
    const { w, d, p, q, hold } = await bridgeDoc()
    await hold(p, 7) // "beta"
    expect(p.querySelector('.ts-word-mark').textContent).toBe('beta')
    await hold(q, 2) // "gamma"
    expect(q.querySelector('.ts-word-mark')?.textContent).toBe('gamma')
    expect(d.querySelectorAll('.ts-word-mark').length).toBe(1)
    expect(w.__paints).toBe(0)
  })

  it('SEL-1: a mark-only clear with no token is a no-op; a real close still clears and repaints', async () => {
    const { w, p, posted, hold } = await bridgeDoc()
    await hold(p, 7)
    expect(clearSelectionJs(undefined, true)).toBe('')
    w.eval(clearSelectionJs(undefined, true) || 'void 0')
    expect(p.querySelector('.ts-word-mark').textContent).toBe('beta')
    w.eval(clearSelectionJs(posted.at(-1)!.token))
    expect(p.querySelector('.ts-word-mark')).toBeNull()
    expect(w.__paints).toBe(1)
  })

})
