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
    expect(src).toMatch(/const claimLibrary = \(userId: string\) =>\s+withDeadline\(claimLibraryFor\(userId\)\.then\(clearWipePending\), LIBRARY_WIPE_MS\)/)
  })

  it('signInWithTokens_ClaimAfterTheEpochBumpBeforeAdoptAndSetUser', () => {
    const fn = between('const signInWithTokens = useCallback', '[runExclusive],')
    const claim = fn.indexOf('await claimLibrary(userData.id)')
    expect(claim).toBeGreaterThan(fn.indexOf('syncStore.reset()'))
    expect(claim).toBeLessThan(fn.indexOf('adoptLocalAccount('))
    expect(claim).toBeLessThan(fn.indexOf('setUser(userData)'))
    // Whether the previous session was a guest goes through capabilities (ADR-014).
    expect(fn).toContain('capabilitiesFor(previous).isGuest')
  })

  it('guestMint_ClaimBeforeSetUser', () => {
    const fn = between('const createGuestOnce = useCallback', '[runExclusive])')
    const claim = fn.indexOf('await claimLibrary(res.user.id)')
    expect(claim).toBeGreaterThan(-1)
    expect(claim).toBeLessThan(fn.indexOf('setUser(res.user)'))
  })

  it('restoredSession_ClaimRetriedNotAwaited_NeverAsks', () => {
    const restore = between('// Restore session on mount', 'sessionReadyRef.current')
    expect(restore).toContain('void claimLibrary(restored.id)')
    expect(restore).not.toContain('mayClaim')
  })

  // #1611: another account's unsynced books are wiped only after a yes, asked before any token is written.
  it('signInWithTokens_AsksBeforeTokensAndClaim_NoReturnsFalse', () => {
    const fn = between('const signInWithTokens = useCallback', '[runExclusive],')
    const ask = fn.indexOf('if (!(await mayClaim(userData.id)))')
    expect(ask).toBeGreaterThan(fn.indexOf('bumpEpoch()'))
    expect(ask).toBeLessThan(fn.indexOf("SecureStore.setItemAsync('access_token'"))
    expect(fn.slice(ask)).toMatch(/^[^\n]+\n[^\n]*\n\s+return false/)
  })

  it('guestMint_AsksBeforeTokensAndClaim_NoIsAFailedMint', () => {
    const fn = between('const createGuestOnce = useCallback', '[runExclusive])')
    const ask = fn.indexOf("if (!(await mayClaim(res.user.id))) return { status: 'failed'")
    expect(ask).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(fn.indexOf("SecureStore.setItemAsync('access_token'"))
  })

  it('ask_NotInsideTheWipeDeadline', () => {
    expect(between('const mayClaim = async', 'tRef.current\n')).toContain('withDeadline(foreignLoss(userId), LIBRARY_WIPE_MS)')
  })
})

describe('sign-out V2 wipe wiring', () => {
  it('signOut_WipesTheV2LibraryBoundedAfterTheEpochBumpBeforeSetUser', () => {
    const wipe = signOut.indexOf('await withDeadline(wipeDeviceLibrary(), ')
    expect(wipe).toBeGreaterThan(signOut.indexOf('syncStore.reset()'))
    expect(wipe).toBeGreaterThan(signOut.indexOf('bumpEpoch()'))
    expect(wipe).toBeLessThan(signOut.indexOf('setUser(null)'))
  })
})
