// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { heroResumeRoute } from './bookRoutes'
import { downloadAndSave, downloadLibraryLink } from './downloadLibraryLink'
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
    expect(src).toMatch(/libraryLink\.start\(fresh \? 'out' : inLibrary \? 'in' : libraryKnownRef\.current \? 'out' : 'unknown', addToLibrary\)/)
    // Cancel: the same confirm-then-remove the Save toggle uses, after the add settles.
    expect(src).toMatch(/onCancel=\{\(\) => \{\s*cancelDownload\(book\.id\)\s*void libraryLink\.cancel\(removeWithConfirm\)\s*\}\}/)
    expect(src).toMatch(/libraryLink\.forget\(\)\s*if \(!inLibrary\) return addToLibrary\(\)\s*return removeWithConfirm\(\)/)
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
    w.eval(READER_SELECTION_BRIDGE)
    const marks = new Map<string, Range>()
    w.__ov = { add: (k: string, r: Range) => marks.set(k, r), remove: (k: string) => marks.delete(k) }
    w.eval('function hlEnsureOverlayer() { return window.__ov }')
    const p = d.getElementById('p')
    const q = d.getElementById('q')
    const hold = async (el: HTMLElement, offset: number) => {
      d.caretRangeFromPoint = () => { const c = d.createRange(); c.setStart(el.firstChild!, offset); return c }
      const touch = new w.Event('touchstart', { bubbles: true })
      Object.defineProperty(touch, 'changedTouches', { value: [{ clientX: 1, clientY: 1 }] })
      el.dispatchEvent(touch)
      await new Promise(res => setTimeout(res, 500))
    }
    return { w, d, p, q, posted, hold, marks }
  }

  it('SEL-1: the word mark is drawn on the overlayer — the chapter text gains no element', async () => {
    const { d, p, hold, marks } = await bridgeDoc()
    const before = { text: d.body.textContent, nodes: d.body.getElementsByTagName('*').length, children: p.childNodes.length }
    await hold(p, 7) // "beta"
    expect(marks.get('ts-word-mark')?.toString()).toBe('beta')
    expect({ text: d.body.textContent, nodes: d.body.getElementsByTagName('*').length, children: p.childNodes.length }).toEqual(before)
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

  it('LIB-1a: Download with no session mints a guest first, then saves; a failed or slow mint still downloads, without the save', async () => {
    // No session → mint → save as a fresh (empty-Library) guest.
    let run = vi.fn(); let save = vi.fn(); let ensureSession = vi.fn(async () => ({ status: 'minted' as const }))
    await downloadAndSave({ run, hasSession: false, ensureSession, save })
    expect(run).toHaveBeenCalledTimes(1); expect(ensureSession).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith(true)
    // Mint fails → download only.
    run = vi.fn(); save = vi.fn()
    await downloadAndSave({ run, hasSession: false, ensureSession: async () => ({ status: 'failed' as const, error: new Error('offline') }), save })
    expect(run).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled()
    // Mint hangs → 3 s deadline → download only.
    vi.useFakeTimers()
    run = vi.fn(); save = vi.fn()
    const p = downloadAndSave({ run, hasSession: false, ensureSession: () => new Promise(() => {}), save })
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000); await p
    expect(save).not.toHaveBeenCalled()
    vi.useRealTimers()
    // A session already there → no mint.
    save = vi.fn(); ensureSession = vi.fn()
    await downloadAndSave({ run: vi.fn(), hasSession: true, ensureSession, save })
    expect(ensureSession).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledWith(false)
    // Device run: the minted session refetches the Library while the add's POST is in flight, and that
    // GET answered "not in library" before the POST finished. The write's success is the last word.
    expect(read('app/book/[slug].tsx')).toMatch(/await libraryApi\.addToLibrary\(book!\.id\)\s*libraryGenRef\.current\+\+\s*setInLibrary\(true\)/)
    expect(read('app/book/[slug].tsx')).toMatch(/await libraryApi\.removeFromLibrary\(book!\.id\)\s*libraryGenRef\.current\+\+\s*setInLibrary\(false\)/)
    // Wiring: the screen's Download handler goes through it with the auth context's ensureSession.
    expect(read('app/book/[slug].tsx')).toMatch(/downloadAndSave\(\{ run, hasSession: isAuthenticated, ensureSession,/)
  })

  it('LIB-1: a failed optimistic add re-reads the Library, so the button shows the server and the state becomes known', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/setInLibrary\(false\)\s*void loadLibrary\(\)\s*return false/)
    expect(src).toMatch(/const loadLibrary = async \(isCancelled = \(\) => false\) => \{[\s\S]*?libraryApi\.getLibrary\(\)[\s\S]*?libraryKnownRef\.current = true/)
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
})
