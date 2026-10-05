import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-asserting guard, in the style of `chapterLoadOrder.test.ts`: reopening a book
 * restores from the DEVICE and never waits on the progress request.
 *
 * The reader used to await `GET` progress before restoring (the upload reader always, the PDF
 * viewer always, the catalog reader for a while). On a good connection or on a plane that is
 * invisible; on a captive portal the reader stares at a book already on the phone until the
 * socket times out. The server is now asked after the restore, in the background, and can only
 * add a newer position (`progressRestore.ts`). Nothing in CI can feel the difference, so the
 * ordering is pinned in the source.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

/** The body of `const <name> = useCallback(` up to its dependency list. */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const end = source.indexOf('\n  }, [', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

const SOURCES = [
  { file: 'src/components/reader/useEditionReaderSource.ts', request: 'readingProgressApi.getProgress(' },
  { file: 'src/components/reader/useUserBookReaderSource.ts', request: 'userBooksApi.getUserBookProgress(' },
]

describe.each(SOURCES)('$file', ({ file, request }) => {
  const source = read(file)

  it('loadPosition — the open path — makes no progress request', () => {
    expect(callbackBody(source, 'loadPosition')).not.toContain(request)
  })

  it('the request lives in loadNewerPosition, the background check', () => {
    expect(callbackBody(source, 'loadNewerPosition')).toContain(request)
  })
})

describe('useReaderPersistence', () => {
  const source = read('src/hooks/useReaderPersistence.ts')

  it('starts the background check only after the restore, and never awaits it', () => {
    const restoreAt = source.indexOf('tryRestore()\n        checkServer()')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(source).not.toMatch(/await\s+(load|loadNewerRef\.current|loadNewerPosition)\(/)
  })
})

describe('useUserBookReaderSource — the PDF resume page', () => {
  const source = read('src/components/reader/useUserBookReaderSource.ts')

  it('opens the document at the device page before asking the server', () => {
    const start = source.indexOf('// --- S4c: Original-layout PDF resume page.')
    const effect = source.slice(start, source.indexOf('// --- S4c: page-based progress persistence', start))
    const readyAt = effect.indexOf('setPdfResumeReady(true)\n      try {')
    const requestAt = effect.indexOf('userBooksApi.getUserBookProgress(')
    expect(readyAt).toBeGreaterThan(-1)
    expect(requestAt).toBeGreaterThan(readyAt)
  })
})
