import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * QA-007 findings that live in React/WebView wiring, where no unit lane reaches.
 * Source-level pins, same shape as readerR4Wiring.test.ts.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
const body = (src: string, from: string, to: string) => {
  const start = src.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf(to, start))
}

describe('a downloaded catalog book is in the Library online too', () => {
  // Online, Library lists GET /me/library; offline it lists the device's downloads. A download
  // that never reached /me/library showed up offline only.
  const screen = read('app/book/[slug].tsx')

  it('a first download adds the book from the screen, awaited, rolled back on failure (review #3)', () => {
    const add = body(screen, 'const addOnDownload = useCallback(', '}, [')
    expect(add).toContain('wasLibraryRemoved(')
    expect(add).toContain('setInLibrary(true)')
    expect(add).toMatch(/await libraryApi\.addToLibrary\(/)
    expect(add).toMatch(/catch[\s\S]*setInLibrary\(false\)/)
    expect(screen).toMatch(/onStart=\{\(\) => \{[^}]*addOnDownload\(\)/)
  })

  it('Restart does not add, and the download loop itself never touches the library (review #4)', () => {
    expect(screen).toMatch(/onRestart=\{\(\) => startDownload\(book, language\)\}/)
    expect(body(read('src/context/DownloadContext.tsx'), 'const startDownload = useCallback(', '}, [')).not.toContain('addToLibrary')
  })

  it('removals are remembered per account, explicit adds forget them (review 2 #1)', () => {
    expect(screen).toContain('markLibraryRemoved(userId, book.id)')
    expect(screen).toContain('clearLibraryRemoved(userId, book.id)')
    expect(screen).toContain('wasLibraryRemoved(userId, id)')
    expect(read('src/hooks/useBookActions.ts')).toContain('markLibraryRemoved(userId, item.editionId)')
  })

  it('the focus refresh waits for an in-flight auto-add and loses to any tap made meanwhile (review 2 #5)', () => {
    const focus = body(screen, 'useFocusEffect(', '}, [book?.id, isAuthenticated, offlineMode])')
    expect(focus).toMatch(/libraryGuard\.begin\(\)[\s\S]*autoAddSettled\([\s\S]*libraryApi\.getLibrary\(\)[\s\S]*libraryGuard\.mayApply\(/)
    expect(body(screen, 'const addOnDownload = useCallback(', '}, [')).toContain('libraryGuard.touch()')
    expect(body(screen, 'const toggle = async () => {', 'if (!wasInLibrary) return toggle()')).toContain('libraryGuard.touch()')
  })
})

describe('the WebView selection ends with the toolbar', () => {
  const actions = read('src/components/reader/useReaderWordActions.ts')

  it('every path that sets the selection to null clears the native range and the word mark', () => {
    // One place, not one per caller: ten call sites set the selection to null.
    const effect = body(actions, 'selectionWasOpenRef', 'return {')
    expect(effect).toMatch(/injectJs\(clearSelectionJs\(/)
  })

  it('a late clear cannot wipe a newer selection: the clear carries the closed selection\'s token (review 2 #7)', () => {
    const effect = body(actions, 'selectionWasOpenRef', 'return {')
    expect(effect).toContain('closedTokenRef.current')
    expect(actions).toMatch(/__tsClearSelection\(/)
    const bridge = read('src/lib/readerBridge.ts')
    expect(bridge).toMatch(/window\.__tsClearSelection = function\(token, markOnly\)[\s\S]*token !== _selToken\) return/)
    // Every non-empty selection message names its token.
    const posts = bridge.match(/type: 'selection',\s*\n[\s\S]*?\}\)\);/g) ?? []
    expect(posts.length).toBeGreaterThanOrEqual(3)
    for (const p of posts) expect(p).toContain('token: _selToken')
    expect(read('src/hooks/useReaderSelection.ts')).toContain('token:')
  })

  it('a highlight touches neither the native selection nor the mark until the save succeeds (review #5)', () => {
    const highlight = body(actions, 'const handleHighlight = useCallback(', '}, [')
    expect(highlight).not.toContain('CLEAR_SELECTION_JS')
    // The selection is closed (→ effect clears range + mark) only on success; on failure it stays.
    expect(highlight).toMatch(/const ok = await createHighlight\([\s\S]*if \(ok\) setSelection\(null\)/)
    // The mark is unwrapped in the same script that paints, so the new range is built on clean DOM.
    const create = body(read('src/hooks/useReaderHighlights.ts'), 'const create = useCallback(', 'const createPdf')
    expect(create).toMatch(/__tsClearSelection\([\s\S]*renderHighlight\(/)
    expect(create).toContain('return true')
    expect(create).toContain('return false')
  })
})

describe('code review 2 — the rest', () => {
  it('a highlight with no book id yet says so instead of leaving the toolbar stuck (#6)', () => {
    const create = body(read('src/hooks/useReaderHighlights.ts'), 'const create = useCallback(', 'const createPdf')
    expect(create).toMatch(/if \(!bId\) \{[\s\S]*showToast\([\s\S]*return false/)
  })

  it('Library rows: a finished catalog book offers no Continue, and the place is resolved like everywhere else (#10)', () => {
    const list = read('src/components/library/BookList.tsx')
    const pick = body(list, 'const resumePick: ResumePick | null', '\n\n')
    expect(pick).toMatch(/e\.kind === 'saved'[\s\S]*!isFinished/)
    expect((pick.match(/resumeSlugFor\(/g) ?? []).length).toBe(2)
    expect(pick).not.toContain('resumeChapterSlug(')
  })
})
