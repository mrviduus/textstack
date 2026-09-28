import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-asserting guard, in the style of `authBootstrapOrder.test.ts`.
 *
 * `shareOriginal.ts` wraps three native modules, so it cannot be exercised in
 * Vitest — but the one thing that makes it worth writing is an *ordering*, and an
 * ordering is exactly what a later cleanup flattens: the cache is consulted
 * **before** a token is asked for, so a reader sharing a book they have already
 * downloaded spends no network at all. Reversed, the code still works perfectly
 * on Wi-Fi and silently stops working on a plane.
 */
const SOURCE = resolve(__dirname, 'shareOriginal.ts')

describe('shareOriginalFile', () => {
  const source = readFileSync(SOURCE, 'utf8')

  it('looks on the device before asking for a token', () => {
    const cacheLookup = source.indexOf('getCachedOriginalUri(')
    const tokenCall = source.indexOf('freshAccessToken(')
    expect(cacheLookup).toBeGreaterThan(-1)
    expect(tokenCall).toBeGreaterThan(cacheLookup)
  })

  it('fetches from the network only in the branch where nothing is cached', () => {
    // The download must sit inside the `else`, not run unconditionally with the
    // cached copy as a fallback — that is the same bug wearing a bow tie.
    const elseBranch = source.slice(source.indexOf('  } else {'))
    expect(elseBranch).toContain('downloadFileAsync')
    expect(source.slice(0, source.indexOf('  } else {'))).not.toContain('downloadFileAsync')
  })
})
