import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-asserting guard, in the style of `capabilityLiterals.test.ts`.
 *
 * The bug it prevents cost five orphaned guest users on production in two
 * hours, and was invisible from inside the app: every launch restored the
 * stored session and then immediately minted a new guest over it, leaving the
 * previous guest's library stranded on the server while the reader watched
 * their books disappear.
 *
 * The cause is an ordering contract that no type can express.
 * `AuthContext`'s bootstrap resolves `sessionReadyRef` in the same tick as
 * `setIsLoading(false)`, which releases everything parked in
 * `waitForSession()`. Those continuations resume as microtasks — **before**
 * React commits the render that would assign `userRef.current = user`. So
 * `decideMint`, which reads the ref, sees `null` for a reader who has a
 * perfectly good stored session.
 *
 * The fix is one line: write the ref synchronously in the bootstrap, next to
 * `setUser`. This test exists because that line looks redundant — `userRef` is
 * assigned on every render a few lines above — and is exactly the kind of thing
 * a later cleanup removes.
 */
const SOURCE = resolve(__dirname, '../context/AuthContext.tsx')

describe('AuthContext bootstrap ordering', () => {
  const source = readFileSync(SOURCE, 'utf8')

  it('writes userRef synchronously when restoring a stored session', () => {
    // Not a match on the whole file: the assignment has to be inside the
    // restore branch, before anything can be released to read it.
    const restore = source.slice(
      source.indexOf("SecureStore.getItemAsync('user')"),
      source.indexOf('sessionReadyRef.current!.resolve()'),
    )
    expect(restore.length).toBeGreaterThan(0)
    expect(restore).toMatch(/userRef\.current\s*=/)
  })

  it('still releases waiters only after isLoading is cleared', () => {
    // The other half of the contract. `decideMint` checks `isLoading` first,
    // and a waiter released while it is still true would be told to skip for
    // the wrong reason.
    const clearsLoading = source.indexOf('isLoadingRef.current = false')
    const releases = source.indexOf('sessionReadyRef.current!.resolve()')
    expect(clearsLoading).toBeGreaterThan(-1)
    expect(releases).toBeGreaterThan(clearsLoading)
  })
})
