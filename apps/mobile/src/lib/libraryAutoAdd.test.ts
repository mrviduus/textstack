import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldAutoAddToLibrary } from './libraryAutoAdd'

describe('shouldAutoAddToLibrary — web parity (useReaderLibraryTracking: 1% in)', () => {
  it('adds once the reader is 1% into the book', () => {
    expect(shouldAutoAddToLibrary(0.01, false)).toBe(true)
    expect(shouldAutoAddToLibrary(0.4, false)).toBe(true)
  })

  it('not before 1%, not with an unknown percent, and not twice in one open', () => {
    expect(shouldAutoAddToLibrary(0.009, false)).toBe(false)
    expect(shouldAutoAddToLibrary(null, false)).toBe(false)
    expect(shouldAutoAddToLibrary(0.5, true)).toBe(false)
  })

  it('is wired into the catalog reader save, behind the session check', () => {
    const src = readFileSync(resolve(__dirname, '../components/reader/useEditionReaderSource.ts'), 'utf8')
    const persist = src.slice(src.indexOf('const persist = useCallback('), src.indexOf('}, [isAuthenticated])'))
    const session = persist.indexOf('if (!isAuthenticated) return')
    const add = persist.indexOf('libraryApi.addToLibrary(id)')
    expect(session).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(session)
    expect(persist).toContain('shouldAutoAddToLibrary(snap.bookPercent, libraryAddedRef.current)')
  })
})
