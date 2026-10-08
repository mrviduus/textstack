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
  it('startDownload adds the edition to the library', () => {
    const start = body(read('src/context/DownloadContext.tsx'), 'const startDownload = useCallback(', '}, [')
    expect(start).toMatch(/libraryApi\.addToLibrary\(editionId\)/)
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

  it('a reflow highlight clears the mark BEFORE painting, so its range is built on clean DOM', () => {
    const highlight = body(actions, 'const handleHighlight = useCallback(', '}, [')
    const clear = highlight.indexOf('injectJs(CLEAR_SELECTION_JS)')
    expect(clear).toBeGreaterThan(-1)
    expect(clear).toBeLessThan(highlight.indexOf('await createHighlight('))
  })
})
