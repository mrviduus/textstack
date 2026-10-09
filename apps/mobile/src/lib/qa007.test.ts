// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { heroResumeRoute } from './bookRoutes'
import { downloadAndSave, downloadLibraryLink } from './downloadLibraryLink'
import { READER_SELECTION_BRIDGE } from './readerBridge'
import { clearSelectionJs } from './readerSelectionJs'
import { buildReaderHtml } from './readerHtml'
import { createRequire } from 'node:module'
import { withDeadline } from './deadline'

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
        // Cancel: the same confirm-then-remove the Save toggle uses, after the add settles.
    expect(src).toMatch(/onCancel=\{\(\) => \{\s*cancelDownload\(book\.id\)\s*void libraryLink\.cancel\(removeWithConfirm\)\s*\}\}/)
    expect(src).toMatch(/const removeWithConfirm = async \(\) => \{[\s\S]*?collectionsApi\.listCollections\(\)[\s\S]*?decideLibraryRemoval/)
    // Known only once getLibrary's answer was applied (gen-guarded against local changes in flight).
    expect(src).toMatch(/const gen = libraryGenRef\.current\s*const lib = await libraryApi\.getLibrary\(\)\s*if \(!isCancelled\(\) && gen === libraryGenRef\.current\) \{\s*libraryKnownRef\.current = true/)
    expect(src).toMatch(/await loadLibrary\(\(\) => cancelled\)/)
    // The add reports success; failure rolls back.
    expect(src).toMatch(/const addToLibrary = async \(\): Promise<boolean> => \{\s*libraryGenRef\.current\+\+\s*setInLibrary\(true\)[\s\S]*?return true[\s\S]*?setInLibrary\(false\)[\s\S]*?return false/)
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

  it('RES-1: a failed lookup opens the detail screen, never a stale chapterSlug', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.5, chapterSlug: 'ch-2', locator: 'page:300', updatedAtMs: 1 }
    const failing = { device: async () => ({ chapters: [], totalChapters: 0 }), server: async () => { throw new Error('offline') } }
    expect(await heroResumeRoute(pick, failing)).toBe('/my-books/ub1')
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
    expect(hero).toMatch(/listCachedUserChapterPages\(id\)/)
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

  it('RES-1: a device cache without page numbers falls through to the server', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:12', updatedAtMs: 1 }
    // Complete download, but rows cached from the chapter endpoint, which sends no sourceStartPage.
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: null }, { slug: 'ch1', sourceStartPage: null }], totalChapters: 2 })
    const server = vi.fn(async () => [{ slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 }, { slug: 'ch1', chapterNumber: 1, sourceStartPage: 10 }])
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('RES-1: caching an upload stores sourceStartPage from the chapter list, so the device alone places page N', async () => {
    // The download task carries the list's start page; the chapter endpoint does not send one.
    const dl = read('src/context/DownloadContext.tsx')
    expect(dl).toMatch(/number: ch\.chapterNumber,\s*sourceStartPage: ch\.sourceStartPage \?\? null,/)
    expect(dl).toContain('cacheUserChapter(info.editionId, { ...chapter, sourceStartPage: chapter.sourceStartPage ?? task.sourceStartPage ?? null }, task.number)')
    // The reader's own pre-cache does the same from its chapter list.
    expect(read('src/components/reader/useUserBookReaderSource.ts')).toMatch(/cacheUserChapter\(bookId, \{ \.\.\.ch, sourceStartPage: ch\.sourceStartPage \?\? row\?\.sourceStartPage \?\? null \}/)
    // A refresh from the chapter endpoint must not wipe the stored page.
    expect(read('src/lib/offlineDb.ts')).toContain('source_start_page = COALESCE(?, source_start_page)')
    // Those rows then answer the hero alone.
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:12', updatedAtMs: 1 }
    const server = vi.fn()
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: 10 }], totalChapters: 2 })
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).not.toHaveBeenCalled()
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

  /** Real bridge in its own jsdom; the reader page's overlayer (readerHtml hlEnsureOverlayer) recorded; a press-and-hold helper. */
  async function bridgeDoc() {
    // @ts-expect-error -- jsdom ships no types and vitest's jsdom env is all we need it for
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<p id="p">alpha beta</p><p id="q">gamma delta</p>', { url: 'https://reader.test/', runScripts: 'outside-only' })
    const w = dom.window as any
    const d = w.document
    const posted: { token?: number }[] = []
    w.ReactNativeWebView = { postMessage: (m: string) => { const x = JSON.parse(m); if (x.type === 'selection' && x.text) posted.push(x) } }
    const marks = new Map<string, Range>()
    const layer = { redraws: 0, element: d.createElement('div'), add: (k: string, r: Range) => marks.set(k, r), remove: (k: string) => marks.delete(k), syncScroll() {}, redraw() { layer.redraws++ } }
    w.__TSOverlayer = { create: () => layer, highlight: null }
    w.eval(READER_SELECTION_BRIDGE)
    const p = d.getElementById('p')
    const q = d.getElementById('q')
    const hold = async (el: HTMLElement, offset: number) => {
      d.caretRangeFromPoint = () => { const c = d.createRange(); c.setStart(el.firstChild!, offset); return c }
      const touch = new w.Event('touchstart', { bubbles: true })
      Object.defineProperty(touch, 'changedTouches', { value: [{ clientX: 1, clientY: 1 }] })
      el.dispatchEvent(touch)
      await new Promise(res => setTimeout(res, 500))
    }
    return { w, d, p, q, posted, hold, marks, layer }
  }

  it('SEL-1: the word mark is drawn on the overlayer — the chapter text gains no element', async () => {
    const { p, hold, marks } = await bridgeDoc()
    const before = { html: p.innerHTML, children: p.childNodes.length }
    await hold(p, 7) // "beta"
    expect(marks.get('ts-word-mark')?.toString()).toBe('beta')
    expect({ html: p.innerHTML, children: p.childNodes.length }).toEqual(before)
  })

  it('SEL-1: closing the mark leaves a highlight Range in the same paragraph intact', async () => {
    const { w, d, p, posted, hold, marks } = await bridgeDoc()
    const hl = d.createRange(); hl.setStart(p.firstChild, 0); hl.setEnd(p.firstChild, 5) // "alpha" highlighted
    await hold(p, 7)
    w.eval(clearSelectionJs(posted.at(-1)!.token))
    expect(marks.has('ts-word-mark')).toBe(false)
    expect(hl.collapsed).toBe(false)
    expect(hl.toString()).toBe('alpha')
  })

  it('SEL-1: tapping a second word moves the mark', async () => {
    const { p, q, hold, marks } = await bridgeDoc()
    await hold(p, 7)
    await hold(q, 2)
    expect(marks.get('ts-word-mark')?.toString()).toBe('gamma')
    expect(marks.size).toBe(1)
  })

  it('SEL-1: a stale clear leaves the newer mark; a mark-only clear with no token is a no-op', async () => {
    const { w, p, q, posted, hold, marks } = await bridgeDoc()
    await hold(p, 7)
    const older = posted.at(-1)!.token
    await hold(q, 2)
    w.eval(clearSelectionJs(older))
    expect(marks.get('ts-word-mark')?.toString()).toBe('gamma')
    expect(clearSelectionJs(undefined, true)).toBe('')
  })

  it('SEL-1: a word marked inside a highlight — a tap on it still opens the highlight (the mark is never hit-tested)', async () => {
    const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom')
    const posted: { type: string; highlightId?: string }[] = []
    const rect = { x: 20, y: 300, left: 20, top: 300, right: 80, bottom: 320, width: 60, height: 20 }
    const dom = new JSDOM(buildReaderHtml('<p>She sat in the garden and watched the moon.</p>', undefined, 'ch-1'), {
      runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
      beforeParse(win: any) {
        win.ReactNativeWebView = { postMessage: (m: string) => posted.push(JSON.parse(m)) }
        // No layout in jsdom: every range sits on the same rect, as a word inside its highlight does.
        win.Range.prototype.getClientRects = function () { return [rect] }
        win.Range.prototype.getBoundingClientRect = function () { return rect }
      },
    })
    const w = dom.window as any
    const d = w.document
    w.eval(`renderHighlight("h1", ${JSON.stringify(JSON.stringify({ prefix: 'She sat in the ', exact: 'garden', suffix: ' and' }))}, "yellow", "garden")`)
    const text = d.querySelector('p').firstChild
    d.caretRangeFromPoint = () => { const c = d.createRange(); c.setStart(text, 17); return c }
    const touch = new w.Event('touchstart', { bubbles: true })
    Object.defineProperty(touch, 'changedTouches', { value: [{ clientX: 30, clientY: 310 }] })
    d.querySelector('p').dispatchEvent(touch)
    await new Promise(res => setTimeout(res, 1000)) // hold fires, then the justAnchored window passes
    expect(posted.some(m => m.type === 'selection' && (m as any).text === 'garden')).toBe(true)
    d.body.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 30, clientY: 310 }))
    expect(posted.filter(m => m.type === 'highlightTap')).toEqual([{ type: 'highlightTap', highlightId: 'h1' }])
  })

  it('SEL-1: a drag selection collapsing clears the word mark itself (RN\'s clear carries a token the collapse made stale)', async () => {
    const { w, d, p, q, hold, marks } = await bridgeDoc()
    await hold(p, 7) // "beta" marked
    await new Promise(res => setTimeout(res, 1600)) // past the tap's suppression window
    d.dispatchEvent(new w.Event('selectionchange')); await new Promise(res => setTimeout(res, 300)) // ActionMode gone: tap state reset
    const r = d.createRange(); r.setStart(q.firstChild, 0); r.setEnd(q.firstChild, 11)
    w.getSelection().addRange(r)
    d.dispatchEvent(new w.Event('selectionchange')); await new Promise(res => setTimeout(res, 300))
    w.getSelection().removeAllRanges()
    d.dispatchEvent(new w.Event('selectionchange')); await new Promise(res => setTimeout(res, 300))
    expect(marks.has('ts-word-mark')).toBe(false)
  })

  it('SEL-1: the word mark redraws on resize/rotate, as on scroll', async () => {
    const { w, p, hold, layer } = await bridgeDoc()
    await hold(p, 7)
    w.dispatchEvent(new w.Event('resize'))
    expect(layer.redraws).toBe(1)
  })

  it('LIB-1: a finished or removed download forgets it added the book — a later download + Cancel never removes it', async () => {
    const remove = vi.fn()
    // add → finish/remove download → download again (book already in) → cancel → NOT removed.
    const link = downloadLibraryLink()
    link.start('out', async () => true)
    link.forget()
    link.start('in', vi.fn())
    await link.cancel(remove)
    expect(remove).not.toHaveBeenCalled()
    // Wiring: the screen forgets when the download completes and when it is removed.
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/status === 'complete'\) libraryLink\.forget\(\)/)
    expect(src).toMatch(/onRemove=\{\(\) => \{\s*libraryLink\.forget\(\)/)
  })

  it('LIB-1a: Download with no session mints a guest first, then saves; a failed or never-answering mint still downloads, without the save', async () => {
    // No session → mint → save as a fresh (empty-Library) guest.
    let run = vi.fn(); let save = vi.fn(); let ensureSession = vi.fn(async () => ({ status: 'minted' as const }))
    await downloadAndSave({ run, getAccessToken: async () => null, hasSession: false, ensureSession, save })
    expect(run).toHaveBeenCalledTimes(1); expect(ensureSession).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith(true)
    // Mint fails → download only.
    run = vi.fn(); save = vi.fn()
    await downloadAndSave({ run, getAccessToken: async () => null, hasSession: false, ensureSession: async () => ({ status: 'failed' as const, error: new Error('offline') }), save })
    expect(run).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled()
    // Mint never answers → download only (nothing waits on it).
    vi.useFakeTimers()
    run = vi.fn(); save = vi.fn()
    void downloadAndSave({ run, getAccessToken: async () => null, hasSession: false, ensureSession: () => new Promise(() => {}), save })
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).not.toHaveBeenCalled()
    vi.useRealTimers()
    // A session already there → no mint.
    save = vi.fn(); ensureSession = vi.fn()
    await downloadAndSave({ run: vi.fn(), getAccessToken: async () => null, hasSession: true, ensureSession, save })
    expect(ensureSession).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledWith(false)
    // Device run: the minted session refetches the Library while the add's POST is in flight, and that
    // GET answered "not in library" before the POST finished. The write's success is the last word.
    expect(read('app/book/[slug].tsx')).toMatch(/await libraryApi\.addToLibrary\(book!\.id\)\s*libraryGenRef\.current\+\+\s*setInLibrary\(true\)/)
    expect(read('app/book/[slug].tsx')).toMatch(/await libraryApi\.removeFromLibrary\(book!\.id\)\s*libraryGenRef\.current\+\+\s*setInLibrary\(false\)/)
    // Wiring: the screen's Download handler goes through it with the auth context's ensureSession.
    expect(read('app/book/[slug].tsx')).toMatch(/downloadAndSave\(\{ run, hasSession: isAuthenticated, ensureSession, getAccessToken,/)
  })

  it('LIB-1: a failed optimistic add re-reads the Library, so the button shows the server and the state becomes known', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/setInLibrary\(false\)\s*void loadLibrary\(\)\s*return false/)
    expect(src).toMatch(/const loadLibrary = async \(isCancelled = \(\) => false\) => \{[\s\S]*?libraryApi\.getLibrary\(\)[\s\S]*?libraryKnownRef\.current = true/)
  })

  it('RES-1: a server lookup writes the start pages into the device cache, so the next offline Continue works', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:12', updatedAtMs: 1 }
    // A download made before start pages were stored: complete, no pages.
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: null }, { slug: 'chapter-1', sourceStartPage: null }], totalChapters: 2 })
    const server = async () => [{ slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 }, { slug: null, chapterNumber: 1, sourceStartPage: 10 }]
    const remember = vi.fn(async () => {})
    expect(await heroResumeRoute(pick, { device, server, remember })).toBe('/my-books/read/ub1/chapter-1')
    expect(remember).toHaveBeenCalledWith('ub1', [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'chapter-1', sourceStartPage: 10 }])
    // A failing write never blocks the Continue.
    expect(await heroResumeRoute(pick, { device, server, remember: async () => { throw new Error('db') } })).toBe('/my-books/read/ub1/chapter-1')
    // The device answering alone writes nothing.
    remember.mockClear()
    await heroResumeRoute(pick, { device: async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }], totalChapters: 1 }), server, remember })
    expect(remember).not.toHaveBeenCalled()
    // Wiring: the hero hands them to SQLite, which only fills, never clears.
    expect(read('src/components/library/ResumeHero.tsx')).toMatch(/remember: storeCachedUserChapterStartPages/)
    expect(read('src/lib/offlineDb.ts')).toMatch(/UPDATE user_chapters SET source_start_page = \? WHERE book_id = \? AND chapter_slug = \? AND source_start_page IS NULL/)
    expect(read('src/lib/offlineDb.web.ts')).toContain('export async function storeCachedUserChapterStartPages')
  })

  it('LIB-1: a hand Save/remove ends the link and waits for an in-flight Download add before its DELETE', async () => {
    for (const state of ['out', 'unknown'] as const) {
      const order: string[] = []
      let settle!: (ok: boolean) => void
      const link = downloadLibraryLink()
      link.start(state, () => new Promise<boolean>(r => { settle = ok => { order.push('add'); r(ok) } }))
      const removed = link.forget().then(() => { order.push('remove') })
      await Promise.resolve()
      expect(order).toEqual([])
      settle(true); await removed
      expect(order).toEqual(['add', 'remove'])
    }
    // A failed add still releases the wait.
    const link = downloadLibraryLink()
    link.start('out', async () => { throw new Error('offline') })
    await expect(link.forget()).resolves.toBeUndefined()
    // Wiring: the Save button's remove path awaits it.
    expect(read('app/book/[slug].tsx')).toMatch(/const pending = libraryLink\.forget\(\)\s*if \(!inLibrary\) return addToLibrary\(\)\s*await pending\s*return removeWithConfirm\(\)/)
  })

  it('LIB-1: the Download save, run after the session mint, reads the current inLibrary, not the tap-time render', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/const inLibraryRef = useRef\(inLibrary\)\s*inLibraryRef\.current = inLibrary/)
    expect(src).toMatch(/libraryLink\.start\(fresh \? 'out' : inLibraryRef\.current \? 'in' : libraryKnownRef\.current \? 'out' : 'unknown', addToLibrary\)/)
  })

  it('one deadline helper: rejects after ms, settles with the promise otherwise; both waits use it', async () => {
    vi.useFakeTimers()
    const late = withDeadline(new Promise(() => {}), 3000)
    const caught = late.catch(e => e.message)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await caught).toBe('deadline')
    vi.useRealTimers()
    expect(await withDeadline(Promise.resolve(7), 10)).toBe(7)
    await expect(withDeadline(Promise.reject(new Error('x')), 10)).rejects.toThrow('x')
    expect(read('src/lib/bookRoutes.ts')).not.toMatch(/function withDeadline|Promise\.race/)
    expect(read('src/lib/downloadLibraryLink.ts')).not.toMatch(/Promise\.race|setTimeout/)
    // SessionGate's deadline is the same helper, not a timer of its own.
    expect(read('src/components/SessionGate.tsx')).toMatch(/withDeadline\(/)
    expect(read('src/components/SessionGate.tsx')).not.toMatch(/setTimeout/)
  })

  it('RES-1: a device cache with any chapter lacking a start page asks the server', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:50', updatedAtMs: 1 }
    // Mixed old/new rows: ch1 cached before start pages were stored; page 50 lives in ch1 (starts 40).
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: null }, { slug: 'ch2', sourceStartPage: 80 }], totalChapters: 3 })
    const server = vi.fn(async () => [
      { slug: 'ch0', chapterNumber: 0, sourceStartPage: 1 },
      { slug: 'ch1', chapterNumber: 1, sourceStartPage: 40 },
      { slug: 'ch2', chapterNumber: 2, sourceStartPage: 80 },
    ])
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('LIB-1a: a mint that answers after 3 s still saves, in the background; a discarded mint saves under the winning session', async () => {
    vi.useFakeTimers()
    let save = vi.fn()
    const p = downloadAndSave({ run: vi.fn(), hasSession: false, getAccessToken: async () => null, save,
      ensureSession: () => new Promise(r => setTimeout(() => r({ status: 'minted' as const }), 4000)) })
    await vi.advanceTimersByTimeAsync(4000); await p
    expect(save).toHaveBeenCalledWith(true)
    vi.useRealTimers()
    // Another session won the race → save under it.
    save = vi.fn()
    await downloadAndSave({ run: vi.fn(), hasSession: false, getAccessToken: async () => 'tok', save,
      ensureSession: async () => ({ status: 'discarded' as const, reason: 'account-arrived' as const }) })
    expect(save).toHaveBeenCalledWith(false)
    // Discarded and nobody holds a session (signed out meanwhile) → no save.
    save = vi.fn()
    await downloadAndSave({ run: vi.fn(), hasSession: false, getAccessToken: async () => null, save,
      ensureSession: async () => ({ status: 'discarded' as const, reason: 'epoch-moved' as const }) })
    expect(save).not.toHaveBeenCalled()
    expect(read('app/book/[slug].tsx')).toMatch(/downloadAndSave\(\{ run, hasSession: isAuthenticated, ensureSession, getAccessToken,/)
  })

  it('RES-1: unmeasured front matter on a complete download does not force the network — the device places page N', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:50', updatedAtMs: 1 }
    const server = vi.fn(async () => [])
    const device = async () => ({ chapters: [{ slug: 'cover', sourceStartPage: null }, { slug: 'ch0', sourceStartPage: 3 }, { slug: 'ch1', sourceStartPage: 40 }], totalChapters: 3 })
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).not.toHaveBeenCalled()
    // A complete download with no measured row at all still asks the server.
    const none = async () => ({ chapters: [{ slug: 'a', sourceStartPage: null }], totalChapters: 1 })
    await heroResumeRoute(pick, { device: none, server })
    expect(server).toHaveBeenCalledWith('ub1')
  })

  it('RES-1: the hero reads only slug + start page from SQLite, with a web no-op twin', () => {
    const db = read('src/lib/offlineDb.ts')
    expect(db).toMatch(/export async function listCachedUserChapterPages\(bookId: string\)/)
    expect(db).toMatch(/SELECT chapter_slug, source_start_page FROM user_chapters WHERE book_id = \? ORDER BY COALESCE\(chapter_number, 999999\) ASC, cached_at ASC/)
    expect(read('src/lib/offlineDb.web.ts')).toContain('export async function listCachedUserChapterPages')
    expect(read('src/components/library/ResumeHero.tsx')).not.toMatch(/listCachedUserChapters\b/)
  })

  it('RES-1: storing start pages is one transaction and skips rows that already have one', () => {
    const db = read('src/lib/offlineDb.ts')
    const fn = db.slice(db.indexOf('export async function storeCachedUserChapterStartPages'), db.indexOf('export async function listCachedUserChapters'))
    expect(fn).toMatch(/withTransactionAsync/)
    expect(fn).toMatch(/AND source_start_page IS NULL/)
    expect(fn).toMatch(/if \(c\.sourceStartPage == null\) continue/)
  })

  it('SEL-1: the word mark redraws on image load and fonts.ready, like the highlight overlayer', async () => {
    const { w, d, p, hold, layer } = await bridgeDocWithFonts()
    await hold(p, 7)
    await Promise.resolve(); await Promise.resolve()
    expect(layer.redraws).toBe(1)
    const img = d.createElement('img'); d.body.appendChild(img)
    img.dispatchEvent(new w.Event('load'))
    expect(layer.redraws).toBe(2)
  })

  async function bridgeDocWithFonts() {
    // fonts.ready must exist before the bridge creates its layer; jsdom ships none.
    const r = await bridgeDoc()
    r.d.fonts = { ready: Promise.resolve() }
    return r
  }
})
