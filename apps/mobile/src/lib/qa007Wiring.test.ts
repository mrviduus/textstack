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

  it('a download adds the book once its first chapter is stored — not at the tap, not at the end (owner 1a)', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    const loop = body(ctx, 'const runDownload = useCallback(', '}, [downloadChapter')
    // Fired once, on the first chapter actually stored; never if nothing could be stored.
    expect(loop).toMatch(/if \(ok\) \{[\s\S]*downloaded\+\+[\s\S]*if \(!started\) \{ started = true; onStarted\?\.\(\) \}/)
    expect(body(ctx, 'const startDownload = useCallback(', '}, [')).toMatch(/opts\?\.onStarted/)
    // Retry of a download that stored nothing adds on its first stored chapter too (review 4 #5).
    expect(body(ctx, 'const retryFailed = useCallback(', '}, [')).toMatch(/opts\?\.onStarted/)
    expect(screen).toMatch(/onStart=\{\(\) => \{ const tap = libraryGuard\.begin\(\); void startDownload\(book, language, \{ onStarted: \(\) => \{ void addOnDownloadStart\(tap\) \} \}\) \}\}/)
    expect(screen).toMatch(/onRetry=\{\(\) => \{ const tap = libraryGuard\.begin\(\); void retryFailed\(book\.id, \{ onStarted: \(\) => \{ void addOnDownloadStart\(tap\) \} \}\) \}\}/)
  })

  it('the add reads the CURRENT state when the download starts: no add if already in, or if Remove was tapped since (review 4 #2)', () => {
    const add = body(screen, 'const addOnDownloadStart = useCallback(', '}, [')
    expect(add).toMatch(/inLibraryRef\.current/)
    expect(add).toMatch(/!libraryGuard\.mayApply\(tap\)/)
    expect(add).toMatch(/setInLibrary\(true\)[\s\S]*await libraryGuard\.track\(libraryApi\.addToLibrary\([\s\S]*catch[\s\S]*setInLibrary\(false\)/)
  })

  it('the Save toggle\'s POST is tracked, so a focus refresh cannot land on top of it (review 4 #3)', () => {
    const toggle = body(screen, 'const toggle = async () => {', 'if (!wasInLibrary) return toggle()')
    expect(toggle).toMatch(/libraryGuard\.track\(libraryApi\.removeFromLibrary\(/)
    expect(toggle).toMatch(/libraryGuard\.track\(libraryApi\.addToLibrary\(/)
  })

  it('Restart does not add, and the download loop itself never touches the library', () => {
    expect(screen).toMatch(/onRestart=\{\(\) => startDownload\(book, language\)\}/)
    expect(body(read('src/context/DownloadContext.tsx'), 'const startDownload = useCallback(', '}, [')).not.toContain('addToLibrary')
  })

  it('no auto-add machinery is left: no 1% add, no removal markers (review 3 #1, #2)', () => {
    expect(read('src/components/reader/useEditionReaderSource.ts')).not.toMatch(/autoAdd|addToLibrary/)
    expect(screen).not.toMatch(/autoAdd|LibraryRemoved/)
    expect(read('src/hooks/useBookActions.ts')).not.toMatch(/LibraryRemoved/)
  })

  it('focus re-reads "In Library"; a tap or a POST in flight beats it', () => {
    const focus = body(screen, 'useFocusEffect(', '}, [book?.id, isAuthenticated, offlineMode])')
    expect(focus).toMatch(/libraryGuard\.begin\(\)[\s\S]*libraryApi\.getLibrary\(\)[\s\S]*libraryGuard\.mayApply\(/)
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
    // On success only the selection that was highlighted closes — not a newer one (review 3 #5).
    expect(highlight).toMatch(/const ok = await createHighlight\([\s\S]*if \(ok\) setSelection\(cur => \(cur\?\.selectionId === selection\.selectionId \? null : cur\)\)/)
    // The mark is unwrapped in the same script that paints, so the new range is built on clean DOM —
    // through the one shared helper, not a hand-written copy.
    const create = body(read('src/hooks/useReaderHighlights.ts'), 'const create = useCallback(', 'const createPdf')
    expect(create).toMatch(/clearSelectionJs\(selection\.token, \{ markOnly: true \}\)[\s\S]*renderHighlight\(/)
    expect(create).not.toContain('__tsClearSelection')
    expect(actions).not.toContain('__tsClearSelection')
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
    expect(pick).toContain('editionListPick(e.item.slug, e.item.editionId, serverProgress)')
    expect(pick).toContain('resumeSlugFor(')
    expect(pick).not.toContain('resumeChapterSlug(')
  })

  it('the stale chapterSlug comment is gone (review 4 #8)', () => {
    expect(read('src/components/library/BookList.tsx')).not.toContain('Following it sent a reader 45%')
  })
})
