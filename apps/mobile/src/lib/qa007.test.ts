// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { heroResumeRoute } from './bookRoutes'
import { downloadAndSave } from './downloadAndSave'
import { clearSelectionJs } from './readerSelectionJs'
import { openEnginePage, HELD_MS, SETTLED_MS } from '../test/enginePage'
import { withDeadline } from './deadline'

/** QA-007 owner rules. Screens and the WebView aren't drivable here: behaviour where a pure piece exists, source guards for the wiring. */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('QA-007', () => {
  it('LIB-1: Cancel stops the download only — the book stays in the Library (a download is intent)', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/onCancel=\{\(\) => cancelDownload\(book\.id\)\}/)
    expect(src).toMatch(/onRemove=\{\(\) => removeDownload\(book\.id\)\.then\(\(\) => setCached\(false\)\)\}/)
  })

  it('LIB-1 wiring: Download/Retry/Restart share one handler (its save: useBookLibrary.test.ts)', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/onStart=\{onDownload\(\(\) => startDownload\(book, language\)\)\}/)
    expect(src).toMatch(/onRetry=\{onDownload\(\(\) => retryFailed\(book\.id\)\)\}/)
    expect(src).toMatch(/onRestart=\{onDownload\(\(\) => startDownload\(book, language\)\)\}/)
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

  // SEL-1 on the engine page (buildEngineReaderHtml): RN's real clearSelectionJs injected into the real page.
  const SEL_CHAPTER = '<p>alpha beta</p><p>gamma delta</p>'
  async function selPage(html = SEL_CHAPTER) {
    const page = await openEnginePage(html)
    const [p, q] = Array.from(page.root.querySelectorAll('p'))
    const selections = () => page.messages.filter((m) => m.type === 'selection') as unknown as { text: string; token?: number }[]
    const wordMarks = () => page.root.querySelectorAll('svg [data-group="selection"]').length
    /** Press and hold on `el` at `offset` of its text (the engine's hold reads the caret there). */
    const hold = async (el: Element, offset: number) => {
      ;(page.w as unknown as { __caret: () => Range }).__caret = () => { const c = page.w.document.createRange(); c.setStart(el.firstChild!, offset); return c }
      el.dispatchEvent(new page.w.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 30, clientY: 310 }))
      await new Promise(res => setTimeout(res, HELD_MS))
    }
    /** A drag selection over [start, end) of `el`'s text, once it settles; null = collapse it. */
    const drag = async (el: Element | null, start = 0, end = 0) => {
      const sel = page.w.document.getSelection()!
      sel.removeAllRanges()
      if (el) { const r = page.w.document.createRange(); r.setStart(el.firstChild!, start); r.setEnd(el.firstChild!, end); sel.addRange(r) }
      page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
      await new Promise(res => setTimeout(res, SETTLED_MS))
    }
    return { ...page, p, q, selections, wordMarks, hold, drag }
  }

  it('SEL-1: closing a selection clears the WebView one, never a newer one; highlight keeps it on failure', async () => {
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

  it('SEL-1: selection tokens are unique across documents — a stale clear from the last chapter never matches', async () => {
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

  it('SEL-1: the word mark is drawn on the overlay — the chapter text gains no element', async () => {
    const page = await selPage()
    const before = { html: page.p.innerHTML, children: page.p.childNodes.length }
    await page.hold(page.p, 7) // "beta"
    expect(page.selections().at(-1)).toMatchObject({ text: 'beta' })
    expect(page.wordMarks()).toBe(1)
    expect({ html: page.p.innerHTML, children: page.p.childNodes.length }).toEqual(before)
  })

  it('SEL-1: closing the mark leaves a highlight in the same paragraph intact', async () => {
    const page = await selPage()
    page.call(`renderHighlight('h1', ${JSON.stringify(JSON.stringify({ prefix: '', exact: 'alpha', suffix: ' beta' }))}, 'yellow', 'alpha')`)
    await page.hold(page.p, 7)
    page.call(clearSelectionJs(page.selections().at(-1)!.token))
    expect(page.wordMarks()).toBe(0)
    expect(page.root.querySelectorAll('svg [data-group="highlight"][data-id="h1"]').length).toBe(1)
  })

  it('SEL-1: a mark-only clear (before a highlight paints) drops the word mark but keeps the selection, so a failed save can retry', async () => {
    const page = await selPage()
    await page.hold(page.p, 7)
    page.call(clearSelectionJs(page.selections().at(-1)!.token, true))
    expect(page.wordMarks()).toBe(0)
    await page.drag(page.q, 0, 5) // "gamma"
    const sent = page.selections().length
    page.call(clearSelectionJs(page.selections().at(-1)!.token, true))
    expect(page.w.document.getSelection()!.toString()).toBe('gamma')
    await new Promise(res => setTimeout(res, SETTLED_MS))
    expect(page.selections()).toHaveLength(sent) // nothing posted: RN's toolbar stays
    // The full clear still ends it.
    page.call(clearSelectionJs(page.selections().at(-1)!.token))
    expect(page.w.document.getSelection()!.toString()).toBe('')
  })

  it('SEL-1: holding a second word moves the mark', async () => {
    const page = await selPage()
    await page.hold(page.p, 7)
    await page.hold(page.q, 2)
    expect(page.selections().at(-1)).toMatchObject({ text: 'gamma' })
    expect(page.wordMarks()).toBe(1)
  })

  it('SEL-1: a stale clear leaves the newer mark; a mark-only clear with no token is a no-op', async () => {
    const page = await selPage()
    await page.hold(page.p, 7)
    const older = page.selections().at(-1)!.token
    await page.hold(page.q, 2)
    page.call(clearSelectionJs(older))
    expect(page.wordMarks()).toBe(1)
    expect(clearSelectionJs(undefined, true)).toBe('')
  })

  it('SEL-1: a word marked inside a highlight — a tap on it still opens the highlight (the mark is never hit-tested)', async () => {
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

  it('SEL-1: a drag selection replaces the word mark, and its collapse ends the selection', async () => {
    const page = await selPage()
    await page.hold(page.p, 7) // "beta" marked
    await page.drag(page.q, 0, 11)
    expect(page.wordMarks()).toBe(0)
    await page.drag(null)
    expect(page.selections().at(-1)).toEqual({ type: 'selection', text: '' })
    expect(page.wordMarks()).toBe(0)
  })

  it('LIB-1a: Download with no session mints a guest first, then saves; a failed or never-answering mint still downloads, without the save', async () => {
    // No session → mint → save as a fresh (empty-Library) guest.
    let run = vi.fn(); let save = vi.fn(); let ensureSession = vi.fn(async () => ({ status: 'minted' as const }))
    await downloadAndSave({ run, getAccessToken: async () => null, hasSession: false, ensureSession, save })
    expect(run).toHaveBeenCalledTimes(1); expect(ensureSession).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1)
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
    expect(ensureSession).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledTimes(1)
    // Wiring: the screen's Download handler goes through it with the auth context's ensureSession.
    expect(read('app/book/[slug].tsx')).toMatch(/downloadAndSave\(\{ run, hasSession: isAuthenticated, ensureSession, getAccessToken,/)
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

  it('one deadline helper for the library/resume waits; SessionGate keeps its mount timer', async () => {
    vi.useFakeTimers()
    const late = withDeadline(new Promise(() => {}), 3000)
    const caught = late.catch(e => e.message)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await caught).toBe('deadline')
    vi.useRealTimers()
    expect(await withDeadline(Promise.resolve(7), 10)).toBe(7)
    await expect(withDeadline(Promise.reject(new Error('x')), 10)).rejects.toThrow('x')
    expect(read('src/lib/bookRoutes.ts')).not.toMatch(/function withDeadline|Promise\.race/)
    expect(read('src/lib/downloadAndSave.ts')).not.toMatch(/Promise\.race|setTimeout/)
    // SessionGate keeps its own mount-time timer on purpose: it must also open the gate while the
    // SecureStore bootstrap is wedged, when ensureSession has already answered 'skipped'.
    expect(read('src/components/SessionGate.tsx')).toMatch(/setTimeout\(/)
  })

  it('RES-1: unmeasured back matter on a complete download does not force the network — the device places page N', async () => {
    // Review r8: the server has null for these rows too, so asking it cannot do better, and offline it fails.
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:50', updatedAtMs: 1 }
    const device = async () => ({ chapters: [{ slug: 'ch0', sourceStartPage: 1 }, { slug: 'ch1', sourceStartPage: 40 }, { slug: 'index', sourceStartPage: null }], totalChapters: 3 })
    const server = vi.fn(async () => { throw new Error('offline') })
    expect(await heroResumeRoute(pick, { device, server })).toBe('/my-books/read/ub1/ch1')
    expect(server).not.toHaveBeenCalled()
  })

  it('RES-1: a device cache with a chapter lacking a start page between paged ones asks the server', async () => {
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
    expect(save).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    // Another session won the race → save under it.
    save = vi.fn()
    await downloadAndSave({ run: vi.fn(), hasSession: false, getAccessToken: async () => 'tok', save,
      ensureSession: async () => ({ status: 'discarded' as const, reason: 'account-arrived' as const }) })
    expect(save).toHaveBeenCalledTimes(1)
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
})
