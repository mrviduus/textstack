import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every sign-in that can drop a guest session must say so.
 *
 * <p>The server has reported <c>guestMergeSkipped</c> since guest sessions shipped and no client
 * read it (ADR-014). #609 finally read it — on web, in <c>authToastFor</c>, and on mobile in
 * <c>app/(auth)/login.tsx</c>'s <c>warnIfNothingCarried</c>. The mobile side is a hand-written call
 * at each entry point, which means it can be forgotten at one of them, and was.</p>
 *
 * <p>There are exactly FOUR merge entry points — <c>/auth/register</c>, <c>/auth/login</c>,
 * <c>/auth/google</c>, <c>/auth/apple</c> — because those are the four the server consults
 * <c>ResolveGuestToken</c> on. All four go through <c>mobilePost</c>, which attaches the guest
 * bearer, so all four can produce a skip. A screen test would catch this properly; mobile has none
 * and <c>vitest.config.ts</c> is scoped to <c>src/lib/**</c> on purpose, so this greps instead —
 * same shape as <c>routeLiterals.test.ts</c> and <c>capabilityLiterals.test.ts</c>.</p>
 *
 * <p><b>KNOWN_GAPS is the finding.</b> An entry point listed there is one that currently signs the
 * reader in without telling them their earlier work stayed behind. Shrinking the list is always the
 * fix; growing it needs a reason on the line. It was written with one entry — Apple — found by an
 * adversarial QA pass the day after #609 shipped, and emptied the same day.</p>
 */

const LOGIN_SCREEN = join(__dirname, '..', '..', 'app', '(auth)', 'login.tsx')

/** How far after the API call the warning may appear. The handlers are short; 15 is generous. */
const WINDOW = 15

const ENTRY_POINTS = [
  'registerWithEmail',
  'loginWithEmail',
  'loginWithGoogle',
  'loginWithApple',
] as const

/**
 * Entry points that do NOT warn today. Each is a bug, recorded rather than hidden.
 *
 * <p>Empty, and it should stay that way. `loginWithApple` sat here for a few hours on 2026-09-12:
 * `handleAppleSignIn` called `signInWithTokens` + `landAfterAuth` and never `warnIfNothingCarried`,
 * so an iOS reader whose guest row was not merged was landed in a new account with no indication
 * that their highlights, vocabulary and progress had stayed behind. The other three paths in the
 * same file warned. It was written three-quarters right and shipped that way.</p>
 */
const KNOWN_GAPS: { entry: (typeof ENTRY_POINTS)[number]; why: string }[] = []

function source(): string {
  return readFileSync(LOGIN_SCREEN, 'utf8')
}

function warnsWithinWindow(text: string, entry: string): boolean {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.includes(`authApi.${entry}(`))
  if (at < 0) return false
  return lines.slice(at, at + WINDOW).some(l => l.includes('warnIfNothingCarried('))
}

describe('guest-merge warning on every mobile sign-in path', () => {
  it('the login screen still calls all four merge entry points', () => {
    // A rename would make every assertion below pass vacuously, which is the failure mode of a
    // grep-based test.
    const text = source()
    for (const entry of ENTRY_POINTS) {
      expect(text, `authApi.${entry}( not found in login.tsx`).toContain(`authApi.${entry}(`)
    }
    expect(text).toContain('warnIfNothingCarried')
  })

  it.each(ENTRY_POINTS.filter(e => !KNOWN_GAPS.some(g => g.entry === e)))(
    '%s warns when the server reports a skipped merge',
    entry => {
      expect(warnsWithinWindow(source(), entry)).toBe(true)
    },
  )

  it.each(KNOWN_GAPS)(
    'KNOWN GAP: $entry does not warn — $why',
    ({ entry }) => {
      // Characterization. When the call is added, this expectation flips to `true` and the entry
      // moves out of KNOWN_GAPS into the list above.
      expect(warnsWithinWindow(source(), entry)).toBe(false)
    },
  )

  it('warnIfNothingCarried is a no-op when nothing was skipped', () => {
    // The field is null on the ordinary path and the guard must be the first thing in the function,
    // or every successful sign-in shows an error toast.
    const text = source()
    const at = text.indexOf('const warnIfNothingCarried')
    expect(at).toBeGreaterThan(-1)
    const body = text.slice(at, at + 400)
    expect(body).toMatch(/if \(!skipped\) return/)
  })
})
