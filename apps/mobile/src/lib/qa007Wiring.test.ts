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

  it('removals are remembered, explicit adds forget them', () => {
    expect(screen).toContain('markLibraryRemoved(book.id)')
    expect(screen).toContain('clearLibraryRemoved(book.id)')
    expect(read('src/hooks/useBookActions.ts')).toContain('markLibraryRemoved(item.editionId)')
  })

  it('the screen re-reads "In Library" on focus (an auto-add happened in the reader)', () => {
    const focus = body(screen, 'useFocusEffect(', '}, [book?.id, isAuthenticated, offlineMode])')
    expect(focus).toContain('libraryApi.getLibrary()')
  })
})

describe('the WebView selection ends with the toolbar', () => {
  const actions = read('src/components/reader/useReaderWordActions.ts')

  it('every path that sets the selection to null clears the native range and the word mark', () => {
    // One place, not one per caller: ten call sites set the selection to null.
    const effect = body(actions, 'selectionWasOpenRef', 'return {')
    expect(effect).toContain('CLEAR_SELECTION_JS')
    expect(actions).toMatch(/const CLEAR_SELECTION_JS = .*removeAllRanges.*__tsClearWordMark/)
  })

  it('a highlight touches neither the native selection nor the mark until the save succeeds (review #5)', () => {
    const highlight = body(actions, 'const handleHighlight = useCallback(', '}, [')
    expect(highlight).not.toContain('CLEAR_SELECTION_JS')
    // The selection is closed (→ effect clears range + mark) only on success; on failure it stays.
    expect(highlight).toMatch(/const ok = await createHighlight\([\s\S]*if \(ok\) setSelection\(null\)/)
    // The mark is unwrapped in the same script that paints, so the new range is built on clean DOM.
    const create = body(read('src/hooks/useReaderHighlights.ts'), 'const create = useCallback(', 'const createPdf')
    expect(create).toMatch(/__tsClearWordMark[\s\S]*renderHighlight\(/)
    expect(create).toContain('return true')
    expect(create).toContain('return false')
  })
})
