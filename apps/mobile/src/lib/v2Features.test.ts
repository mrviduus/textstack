import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { v2Offers, V2_OFF, type V2Feature } from '@textstack/shared'

/**
 * Source-asserting guard (style of `chapterLoadOrder.test.ts`): every screen that offers something V2
 * lacks asks `v2Offers` for it (#1025), and the session wiring keeps its order. Screens cannot run
 * under Vitest; a gate deleted in a cleanup would show a legacy action that 404s on a V2 book.
 */
const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')

const GATES: [file: string, feature: V2Feature][] = [
  ['src/components/reader/ReaderShell.tsx', 'bookmarks'],
  ['src/components/reader/ReaderShell.tsx', 'markAsKnown'],
  ['src/hooks/useBookActions.ts', 'collections'],
  ['src/hooks/useBookActions.ts', 'retry'],
  ['app/my-books/[id].tsx', 'retry'],
  ['app/my-books/[id].tsx', 'collections'],
  ['app/my-books/[id].tsx', 'insights'],
  ['app/(tabs)/vocabulary.tsx', 'tutor'],
  ['app/(tabs)/vocabulary.tsx', 'clusters'],
  ['src/components/library/StorageQuotaRow.tsx', 'storageQuota'],
  ['app/my-books/upload.tsx', 'storageQuota'],
]

describe('V2_FEATURES gates', () => {
  it.each(GATES)('%s asks v2Offers for %s, hidden on V2 and offered with V2 off', (file, feature) => {
    expect(read(file)).toMatch(new RegExp(`v2Offers\\((?:v2|useV2\\(\\)), '${feature}'\\)`))
    expect(v2Offers({ enabled: true, maxPartBytes: 1 }, feature)).toBe(false)
    expect(v2Offers(V2_OFF, feature)).toBe(true)
  })

  it('the review screen runs in the one mode V2 offers', () => {
    expect(read('app/vocabulary/review.tsx').match(/v2Enabled\(\) \? V2_FEATURES\.reviewModes\[0\]/g)).toHaveLength(2)
  })
})

describe('the V2 session wiring (AuthContext)', () => {
  const src = read('src/context/AuthContext.tsx')

  it('re-keys a merged guest before the user is set, so before the first V2 pull', () => {
    const signIn = src.slice(src.indexOf('const signInWithTokens'), src.indexOf('const updateUser'))
    const reset = signIn.indexOf('v2Store.reset()')
    const merge = signIn.indexOf('applyV2MergeMap(merge)')
    const setUser = signIn.indexOf('setUser(userData)')
    expect(reset).toBeGreaterThan(-1)
    expect(merge).toBeGreaterThan(reset)
    expect(setUser).toBeGreaterThan(merge)
  })

  it('empties the V2 cache on sign-out and on a terminal auth failure', () => {
    const signOut = src.slice(src.indexOf('const signOut'), src.indexOf('// React to terminal auth failures'))
    const failure = src.slice(src.indexOf('onAuthFailure(() =>'), src.indexOf('return unsubscribe'))
    expect(signOut).toContain('v2Store.reset()')
    expect(failure).toContain('v2Store.reset()')
  })
})
