import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * R2 wiring that lives in native-view components (ReaderShell, ToastContext): react-dom cannot
 * mount them, so these stay source guards. Every other R2 pin is a behaviour test:
 * H1 → readerSources.test.ts + useReaderPersistence.test.ts; H2 / M2 / #717 → useReaderBook.test.ts;
 * M9 → useReaderChapterNav.test.ts; H3 → useReaderPersistence.test.ts, readerSources.test.ts,
 * useReaderPdf.test.ts; M1 (hidden on unmount) → useReaderPersistence.test.ts, useReaderPdf.test.ts.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

describe('M9 — the TOC goes through the offline-aware open', () => {
  it('ReaderShell hands a TOC pick to openChapter (native view: not mountable here)', () => {
    const shell = read('src/components/reader/ReaderShell.tsx')
    const toc = shell.slice(shell.indexOf('const handleTocSelect'), shell.indexOf('const toggleCurrentBookmark'))
    expect(toc).toContain('openChapter(')
  })
})

describe('M1 — the newer-position toast', () => {
  it('only the action label runs the action; the body dismisses (native view: not mountable here)', () => {
    const toast = read('src/context/ToastContext.tsx')
    expect(toast).toContain('onPress={hide}')
    expect(toast).toContain('onPress={() => { hide(); current.onPress?.() }}')
    expect(toast).not.toContain('current.onPress ?? hide')
  })
})
