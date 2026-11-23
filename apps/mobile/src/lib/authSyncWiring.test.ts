import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Source-asserting guard: the session wiring keeps its order (AuthContext cannot run under Vitest). */
const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')

describe('the V2 session wiring (AuthContext)', () => {
  const src = read('src/context/AuthContext.tsx')

  it('re-keys a merged guest before the user is set, so before the first V2 pull', () => {
    const signIn = src.slice(src.indexOf('const signInWithTokens'), src.indexOf('const updateUser'))
    const reset = signIn.indexOf('syncStore.reset()')
    const merge = signIn.indexOf('applyMergeMap(merge)')
    const setUser = signIn.indexOf('setUser(userData)')
    expect(reset).toBeGreaterThan(-1)
    expect(merge).toBeGreaterThan(reset)
    expect(setUser).toBeGreaterThan(merge)
  })

  it('empties the V2 cache on sign-out and on a terminal auth failure', () => {
    const signOut = src.slice(src.indexOf('const signOut'), src.indexOf('// React to terminal auth failures'))
    const failure = src.slice(src.indexOf('onAuthFailure(() =>'), src.indexOf('return unsubscribe'))
    expect(signOut).toContain('syncStore.reset()')
    expect(failure).toContain('syncStore.reset()')
  })
})
