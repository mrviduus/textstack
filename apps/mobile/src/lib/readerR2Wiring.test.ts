import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guards for the R2 reader fixes — wiring the WebView makes impossible to drive in CI.
 * Style of `readerResumeWiring.test.ts`; the decisions themselves are tested in readerWriteMode,
 * progressStorage and progressRestore.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
const persistence = read('src/hooks/useReaderPersistence.ts')
const userBook = read('src/components/reader/useUserBookReaderSource.ts')
const edition = read('src/components/reader/useEditionReaderSource.ts')
const shell = read('src/components/reader/ReaderShell.tsx')
const nav = read('src/components/reader/useReaderChapterNav.ts')
const pdfHook = read('src/components/reader/useReaderPdf.ts')

describe('H1 — a PDF upload on a slow network never writes scroll: over page:', () => {
  it('the debounced save reads the CURRENT gate when it fires, not the one it was armed with', () => {
    expect(persistence).toMatch(/debounceRef\.current = setTimeout\(\(\) => \{\s*debounceRef\.current = null\s*saveProgressRef\.current\(\)/)
  })

  it('a pending debounced save is dropped when the book, chapter or mode changes', () => {
    const start = persistence.indexOf("readiness({ type: 'opened'")
    const effect = persistence.slice(start, persistence.indexOf('loadPosition(chapterSlug)', start))
    expect(effect).toContain('clearTimeout(debounceRef.current)')
  })

  it('the reader waits (loading) until the device or the server says whether it is a PDF', () => {
    expect(userBook).toContain('deviceLayout(')
    expect(userBook).toMatch(/loading: loading \|\| !layoutKnown/)
    expect(userBook).toMatch(/enabled: reflowWrites && layoutKnown/)
  })

  it('the device layout path publishes the chapter start pages before the layout (review #1)', () => {
    const start = userBook.indexOf('const layout = deviceLayout(')
    const block = userBook.slice(start, userBook.indexOf('}, [bookId])', start))
    expect(block.indexOf('sourceStartPageBySlugRef.current =')).toBeGreaterThan(-1)
    expect(block.indexOf('sourceStartPageBySlugRef.current =')).toBeLessThan(block.indexOf('setLayoutKnown(true)'))
  })

  it('the offline book path publishes the chapter start pages too', () => {
    const start = userBook.indexOf('const [meta, cachedChapters] = await Promise.all(')
    const block = userBook.slice(start, userBook.indexOf('}).finally(', start))
    expect(block).toContain('sourceStartPageBySlugRef.current =')
  })

  it('remembers the answer on the device for the next open', () => {
    expect(userBook).toContain('setUserBookIsPdf(')
  })

  it('a reflow save of a PDF book keeps the page and never runs under the original viewer', () => {
    const start = userBook.indexOf('const persist = useCallback(')
    const body = userBook.slice(start, userBook.indexOf('\n  }, [', start))
    expect(body).toContain('keepPage')
    expect(body).toMatch(/if \(originalOwnsRef\.current\) return/)
  })
})

describe('H2 / M9 / M2 — offline chapter changes', () => {
  it('the next mount resolves the edition id from this process before the cached-book list', () => {
    const chapterHook = read('src/hooks/useReaderChapter.ts')
    expect(chapterHook).toContain('knownEditionId(')
    expect(chapterHook.indexOf('knownEditionId(')).toBeLessThan(chapterHook.indexOf('getAllCachedBooks('))
    const bookHook = read('src/hooks/useReaderBook.ts')
    expect(bookHook).toContain('rememberEditionId(')
    expect(bookHook).toContain('knownEditionId(')
  })

  it('offline TOC of a downloaded catalog book comes from the device', () => {
    expect(read('src/hooks/useReaderBook.ts')).toContain('listCachedChapters(')
  })

  it('the offline TOC waits for the device id instead of racing it (review #2)', () => {
    const bookHook = read('src/hooks/useReaderBook.ts')
    const catchAt = bookHook.indexOf('.catch(async () => {')
    const block = bookHook.slice(catchAt, bookHook.indexOf('.finally(', catchAt))
    expect(block).toMatch(/await deviceId/)
    expect(block.indexOf('await deviceId')).toBeLessThan(block.indexOf('listCachedChapters('))
  })

  it('chevrons, TOC, bookmarks and highlights go through the offline-aware path', () => {
    expect(shell + nav).not.toMatch(/&& navigateChapter\(/)
    expect(shell + nav).not.toContain('onNavigate={navigateChapter}')
    const start = nav.indexOf('const openChapter = async')
    expect(start).toBeGreaterThan(-1)
    const body = nav.slice(start, nav.indexOf('\n  }\n', start))
    // A tap never waits on a network (review #3): online → navigate now; offline → SQLite only.
    expect(body).not.toContain('ensureChapter(')
    expect(body).toMatch(/if \(online \|\| await isChapterOnDevice\(/)
    // One navigation per tap burst.
    expect(body).toMatch(/if \(openingRef\.current\) return/)
    const toc = shell.slice(shell.indexOf('const handleTocSelect'), shell.indexOf('const toggleCurrentBookmark'))
    expect(toc).toContain('openChapter(')
  })
})

describe('H3 — returning to the foreground checks for a newer position', () => {
  it('listens for the return and asks against the latest local record', () => {
    expect(persistence).toContain("AppState.addEventListener('change'")
    expect(persistence).toContain('returnedToForeground(')
    expect(persistence).toContain('{ latest: true }')
  })

  it.each([
    ['catalog', edition],
    ['upload', userBook],
  ])('%s source re-reads the device record for a foreground check', (_name, source) => {
    const start = source.indexOf('const loadNewerPosition = useCallback(')
    const body = source.slice(start, source.indexOf('\n  }, [', start))
    expect(body).toContain('opts?.latest')
  })
})

describe('H3 — the PDF foreground offer (review #4)', () => {
  it('every offer is a new event, and a return offer measures "moved" from the page at return', () => {
    expect(userBook).toMatch(/setPdfNewerPage\(\{ page: serverPage, at: Date\.now\(\), onReturn: true \}\)/)
    expect(pdfHook).toMatch(/pdfNewerHandledRef\.current === originalNewerPage\.at/)
    expect(pdfHook).toMatch(/originalNewerPage\.onReturn \? pdfReturnPageRef\.current : pdfResumedPageRef\.current/)
    expect(pdfHook).toMatch(/pdfReturnPageRef\.current = currentPdfPageRef\.current/)
  })
})

describe('M1 — the newer-position toast', () => {
  it('only the action label runs the action; the body dismisses', () => {
    const toast = read('src/context/ToastContext.tsx')
    expect(toast).not.toContain('current.onPress ?? hide')
  })

  it('is hidden when the reader unmounts', () => {
    expect(persistence).toMatch(/hideToast\(newerToastRef\.current\)/)
    expect(pdfHook).toMatch(/hideToast\(pdfNewerToastRef\.current\)/)
  })
})

describe('offline title after a chapter turn (review of #717)', () => {
  it('the device lookup still sets the book title when the in-memory edition id was already known', () => {
    const src = read('src/hooks/useReaderBook.ts')
    // An early return on editionIdRef left the header blank and words saved with bookTitle: null.
    expect(src).not.toMatch(/cancelled \|\| editionIdRef\.current\) return/)
  })
})
