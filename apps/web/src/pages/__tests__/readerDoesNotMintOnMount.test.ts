import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-asserting guard.
 *
 * `ReaderPage` used to mint a guest on mount, to keep the first word tap from
 * racing `ensureSession` mid-popup. That race was fixed at its own source a week
 * later — `useReaderChapter` skips a refetch whose key it has already loaded —
 * and the pre-warm then sat there for five months doing nothing but this:
 *
 * Every client that executes JS on a chapter URL received a real `User` row, and
 * the reader's own progress write made that row permanent, because
 * `GuestCleanupWorker` deliberately spares any guest holding progress. On
 * production that produced **7,147 of 7,263** guest accounts — 5,600 of them
 * alive for under five seconds with exactly one progress row each — from
 * undeclared crawlers walking the catalogue behind rotating desktop-Chrome user
 * agents.
 *
 * The line that caused it reads as an obvious performance nicety, which is
 * exactly why it needs a test rather than a comment. A guest is minted on a
 * *commitment* (ADR-014), and rendering a page is not one.
 */
const READER = resolve(__dirname, '../ReaderPage.tsx')

describe('ReaderPage', () => {
  const source = readFileSync(READER, 'utf8')

  it('does not create a session just because the page rendered', () => {
    // Any call, not merely one inside an effect: there is no correct place on
    // this page to mint without the reader having done something.
    expect(source).not.toMatch(/ensureSession\s*\(/)
    expect(source).not.toMatch(/createGuestSession/)
  })

  it('still reads the session it is given', () => {
    // The page is allowed to *observe* auth — it must not be rewritten into
    // something that cannot tell a signed-in reader from an anonymous one.
    expect(source).toMatch(/isAuthenticated/)
  })
})
