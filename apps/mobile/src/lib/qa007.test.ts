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
    expect(src).toMatch(/const addToLibrary = async \(\) => \{\s*setInLibrary\(true\)\s*try \{\s*await libraryApi\.addToLibrary\(book!?\.id\)\s*\} catch \(err\) \{[^}]*setInLibrary\(false\)/)
    // Save to Library uses it.
    expect(src).toContain('if (!wasInLibrary) return addToLibrary()')
    // Download uses it, only when not already in the Library.
    expect(src).toMatch(/onStart=\{\(\) => \{\s*startDownload\(book, language\)\s*if \(isAuthenticated && !inLibrary\) void addToLibrary\(\)\s*\}\}/)
    // Restart does not.
    expect(src).toContain('onRestart={() => startDownload(book, language)}')
  })

  it('RES-1: hero Continue on a page:N upload opens the reader at the chapter holding the page; lookup failure → detail', async () => {
    const pick = { type: 'userbook' as const, id: 'ub1', title: 'PDF', coverPath: null, percent: 0.3, chapterSlug: null, locator: 'page:42', updatedAtMs: 1 }
    const chapters = [
      { slug: 'intro', chapterNumber: 0, sourceStartPage: 1 },
      { slug: null, chapterNumber: 1, sourceStartPage: 30 },
      { slug: 'end', chapterNumber: 2, sourceStartPage: 60 },
    ]
    expect(await heroResumeRoute(pick, async () => chapters)).toBe('/my-books/read/ub1/chapter-1')
    expect(await heroResumeRoute(pick, async () => { throw new Error('offline') })).toBe('/my-books/ub1')
    // No lookup for anything else.
    const load = vi.fn()
    expect(await heroResumeRoute({ ...pick, chapterSlug: 'intro' }, load)).toBe('/my-books/read/ub1/intro')
    expect(await heroResumeRoute({ ...pick, locator: null }, load)).toBe('/my-books/ub1')
    expect(await heroResumeRoute({ type: 'edition', slug: 'dracula', title: 'D', coverPath: null, percent: 0.1, chapterSlug: null, updatedAtMs: 1 }, load)).toBe('/book/dracula')
    expect(load).not.toHaveBeenCalled()
    // The PDF reader restores the page itself when Continue opens the chapter holding it.
    expect(read('src/components/reader/useReaderPdf.ts')).toContain('resumePage: originalNewerPage?.page ?? originalResumePage')
    // Repeat taps ignored while the lookup runs (component-local).
    const hero = read('src/components/library/ResumeHero.tsx')
    expect(hero).toMatch(/if \(busyRef\.current\) return/)
    expect(hero).toContain('heroResumeRoute(pick')
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
    expect(actions).toMatch(/if \(await createHighlight\([^)]*\)\) setSelection\(null\)/)
  })
})
