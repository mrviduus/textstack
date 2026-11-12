import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * AuthContext is not renderable here (no RN renderer), so its sign-out's V2 wipe is pinned by source
 * (#1070): inside `signOut`, after the epoch bump, bounded by a deadline (a hung database open must
 * not hold the auth queue, which sign-in waits on), before the session is cleared in state.
 */
const src = readFileSync(resolve(__dirname, '../context/AuthContext.tsx'), 'utf8')
const signOut = src.slice(src.indexOf('const signOut = useCallback'), src.indexOf('}, [runExclusive])', src.indexOf('const signOut = useCallback')))

describe('sign-out V2 wipe wiring', () => {
  it('signOut_WipesTheV2LibraryBoundedAfterTheEpochBumpBeforeSetUser', () => {
    const wipe = signOut.indexOf('await withDeadline(wipeDeviceV2Library(), ')
    expect(wipe).toBeGreaterThan(signOut.indexOf('v2Store.reset()'))
    expect(wipe).toBeGreaterThan(signOut.indexOf('bumpEpoch()'))
    expect(wipe).toBeLessThan(signOut.indexOf('setUser(null)'))
  })
})
