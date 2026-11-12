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

/** The source between `from` and the first `to` after it. */
const between = (from: string, to: string) => {
  const a = src.indexOf(from)
  return src.slice(a, src.indexOf(to, a))
}

describe('sign-in V2 wipe wiring (#1070 rule B: another account wipes at sign-in)', () => {
  it('claim_BoundedByTheWipeDeadline', () => {
    expect(src).toMatch(/const claimV2Library = \(userId: string\) =>\s+withDeadline\(claimV2LibraryFor\(userId\), V2_WIPE_MS\)/)
  })

  it('signInWithTokens_ClaimAfterTheEpochBumpBeforeAdoptAndSetUser', () => {
    const fn = between('const signInWithTokens = useCallback', '[runExclusive],')
    const claim = fn.indexOf('await claimV2Library(userData.id)')
    expect(claim).toBeGreaterThan(fn.indexOf('v2Store.reset()'))
    expect(claim).toBeLessThan(fn.indexOf('adoptV2LocalAccount('))
    expect(claim).toBeLessThan(fn.indexOf('setUser(userData)'))
    // Whether the previous session was a guest goes through capabilities (ADR-014).
    expect(fn).toContain('capabilitiesFor(previous).isGuest')
  })

  it('guestMint_ClaimBeforeSetUser', () => {
    const fn = between('const createGuestOnce = useCallback', '[runExclusive])')
    const claim = fn.indexOf('await claimV2Library(res.user.id)')
    expect(claim).toBeGreaterThan(-1)
    expect(claim).toBeLessThan(fn.indexOf('setUser(res.user)'))
  })

  it('restoredSession_ClaimRetriedNotAwaited', () => {
    expect(between('// Restore session on mount', 'sessionReadyRef.current')).toContain('void claimV2Library(restored.id)')
  })
})

describe('sign-out V2 wipe wiring', () => {
  it('signOut_WipesTheV2LibraryBoundedAfterTheEpochBumpBeforeSetUser', () => {
    const wipe = signOut.indexOf('await withDeadline(wipeDeviceV2Library(), ')
    expect(wipe).toBeGreaterThan(signOut.indexOf('v2Store.reset()'))
    expect(wipe).toBeGreaterThan(signOut.indexOf('bumpEpoch()'))
    expect(wipe).toBeLessThan(signOut.indexOf('setUser(null)'))
  })
})
