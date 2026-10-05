import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guards for two reader-resume wirings nothing in CI can drive (the WebView is not
 * e2e-drivable). Style of `chapterLoadOrder.test.ts`; the decisions themselves are tested in
 * restoreReadiness / positionHandoff / readerWriteGate.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

describe('C1 — the book id does not wait on the network', () => {
  it('useReaderBook reads the device before it asks the server', () => {
    const source = read('src/hooks/useReaderBook.ts')
    const deviceAt = source.indexOf('getAllCachedBooks(')
    const networkAt = source.indexOf('api.getBook(')
    expect(deviceAt).toBeGreaterThan(-1)
    expect(networkAt).toBeGreaterThan(deviceAt)
  })

  it('useReaderPersistence never forgets a loaded WebView on a book-id change', () => {
    // The reset is the readiness reducer's call (restoreReadiness.ts): only a new document unloads it.
    expect(read('src/hooks/useReaderPersistence.ts')).not.toContain('webViewLoadedRef.current = false')
  })
})

describe('C2 — "read further on another device" to another chapter', () => {
  const source = read('src/hooks/useReaderPersistence.ts')

  it('hands the server position to the next mount and stops the outgoing flush', () => {
    expect(source).toContain('handOffPosition(')
    expect(source).toMatch(/claimPosition(<\w+>)?\(/)
    expect(source).toMatch(/leavingRef\.current = true/)
  })

  it('goes through the shell, so the reading session is carried (L3)', () => {
    expect(source).toContain('chapterNavigatorRef.current')
    expect(read('src/components/reader/ReaderShell.tsx')).toMatch(/chapterNavigatorRef\.current = navigateChapter/)
  })
})
