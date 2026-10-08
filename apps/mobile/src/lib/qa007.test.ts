// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { heroResumeRoute } from './bookRoutes'
import { READER_SELECTION_BRIDGE } from './readerBridge'
import { clearSelectionJs } from './readerSelectionJs'

/** QA-007 owner rules. Screens and the WebView aren't drivable here: behaviour where a pure piece exists, source guards for the wiring. */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('QA-007', () => {
  it('LIB-1: Download adds to Library through the Save to Library path; Restart does not', () => {
    const src = read('app/book/[slug].tsx')
    // One add path: optimistic "In Library", rollback on failure.
    expect(src).toMatch(/const addToLibrary = async \(\) => \{\s*libraryGenRef\.current\+\+\s*setInLibrary\(true\)\s*try \{\s*await libraryApi\.addToLibrary\(book!?\.id\)\s*\} catch \(err\) \{[^}]*setInLibrary\(false\)/)
    // Save to Library uses it.
    expect(src).toContain('if (!wasInLibrary) return addToLibrary()')
    // Download uses it, only when not already in the Library — and remembers that it did.
    expect(src).toMatch(/onStart=\{\(\) => \{\s*startDownload\(book, language\)\s*if \(isAuthenticated && !inLibrary\) \{ addedByDownloadRef\.current = true; void addToLibrary\(\) \}\s*\}\}/)
    // Restart does not.
    expect(src).toContain('onRestart={() => startDownload(book, language)}')
  })

  it('LIB-1: Cancel takes the book back out only when the Download added it; a hand save stays', () => {
    const src = read('app/book/[slug].tsx')
    // One remove path, shared with the Save toggle: optimistic, rollback on failure.
    expect(src).toMatch(/const removeFromLibrary = async \(\) => \{\s*libraryGenRef\.current\+\+\s*setInLibrary\(false\)\s*try \{\s*await libraryApi\.removeFromLibrary\(book!?\.id\)[\s\S]*?\} catch \(err\) \{[^}]*setInLibrary\(true\)/)
    expect(src).toMatch(/const toggle = removeFromLibrary/)
    // Download-added + Cancel → removed. Pre-saved (flag never set) + Cancel → stays.
    expect(src).toMatch(/onCancel=\{\(\) => \{\s*cancelDownload\(book\.id\)\s*if \(addedByDownloadRef\.current\) \{ addedByDownloadRef\.current = false; void removeFromLibrary\(\) \}\s*\}\}/)
    // A hand Save/remove makes the Library state the reader's own: Cancel no longer touches it.
    expect(src).toMatch(/onPress=\{async \(\) => \{\s*addedByDownloadRef\.current = false\s*const wasInLibrary = inLibrary/)
  })

  it('LIB-1: the initial library read never overwrites a local change made while it was in flight', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/const addToLibrary = async \(\) => \{\s*libraryGenRef\.current\+\+/)
    expect(src).toMatch(/const gen = libraryGenRef\.current\s*const lib = await libraryApi\.getLibrary\(\)\s*if \(!cancelled && gen === libraryGenRef\.current\) setInLibrary\(/)
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
    expect(await heroResumeRoute({ ...pick, chapterSlug: 'intro' }, loaders)).toBe('/my-books/read/ub1/intro')
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

})
