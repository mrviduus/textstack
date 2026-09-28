import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-asserting guard, in the style of `capabilityLiterals.test.ts`.
 *
 * The rule, already written in `app/(tabs)/_layout.tsx`: **`canUpload` is the
 * wrong question for a door.** It is `hasSession`, and the session is created by
 * walking through the door — `/my-books/upload` is wrapped in `SessionGate` and
 * mints a guest on arrival. Asking first is the circular reasoning ADR-014 §3a
 * exists to end.
 *
 * It was applied to the tab's visibility and not to the tab's own handler, which
 * went on sending a session-less install to `/(auth)/login`. Found on a device on
 * 2026-09-28: a fresh install tapped "+" and landed on Sign in, with no mint even
 * attempted — the exact wall that was reported fixed three merges earlier.
 *
 * Two places, one rule, and nothing in the type system relates them. Hence this.
 */
const DOORS = [
  'src/components/UploadTabButton.tsx',
  'app/(tabs)/_layout.tsx',
]

describe.each(DOORS)('%s', (file) => {
  const source = readFileSync(resolve(__dirname, '../..', file), 'utf8')

  it('does not send anyone to sign in for want of a session', () => {
    // Prose may discuss it; code may not do it.
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/\(auth\)\/login/)
  })

  it('does not gate the entrance on canUpload', () => {
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/canUpload/)
  })
})
