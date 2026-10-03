import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { carryVisit, claimVisit, CARRY_MS, type ReaderVisit, type Timers } from './readerVisit'

/**
 * A chapter change remounts the reader (router.replace → new route key), and
 * the visit — one reading session, the saved-word count, "finished a chapter" —
 * has to survive it. These pin the hand-over: same book adopts, another book
 * does not, and an unclaimed session is still submitted.
 */

function fakeTimers() {
  const due: { fn: () => void; ms: number; cleared: boolean }[] = []
  const timers: Timers = {
    set: (fn, ms) => { const h = { fn, ms, cleared: false }; due.push(h); return h },
    clear: h => { (h as { cleared: boolean }).cleared = true },
  }
  const fire = () => due.filter(h => !h.cleared).forEach(h => { h.cleared = true; h.fn() })
  return { timers, due, fire }
}

const visit = (o: Partial<ReaderVisit> = {}): ReaderVisit => ({
  key: 'edition:alice',
  session: { startedAt: 1000, activeSeconds: 240, startPercent: 0.1, currentPercent: 0.2, submitted: false },
  savedWords: 3,
  finishedChapter: true,
  ...o,
})

describe('readerVisit', () => {
  beforeEach(() => { claimVisit('__drain__') })

  it('the next chapter of the same book adopts the session, the words and the latch', () => {
    const t = fakeTimers()
    let flushed = 0
    carryVisit(visit(), () => { flushed++ }, t.timers)

    const v = claimVisit('edition:alice')
    expect(v).toMatchObject({ savedWords: 3, finishedChapter: true })
    expect(v!.session).toMatchObject({ startedAt: 1000, activeSeconds: 240, startPercent: 0.1 })
    // Adopted, so the old session is never submitted on its own — one row per visit.
    t.fire()
    expect(flushed).toBe(0)
  })

  it('is claimed once', () => {
    carryVisit(visit(), () => {}, fakeTimers().timers)
    expect(claimVisit('edition:alice')).not.toBeNull()
    expect(claimVisit('edition:alice')).toBeNull()
  })

  it('another book never adopts it — the old session is submitted instead', () => {
    let flushed = 0
    carryVisit(visit(), () => { flushed++ }, fakeTimers().timers)
    expect(claimVisit('userbook:42')).toBeNull()
    expect(flushed).toBe(1)
  })

  it('submits the session when nobody claims it in time (next chapter failed, reader left)', () => {
    const t = fakeTimers()
    let flushed = 0
    carryVisit(visit(), () => { flushed++ }, t.timers)
    expect(t.due[0].ms).toBe(CARRY_MS)
    t.fire()
    expect(flushed).toBe(1)
    expect(claimVisit('edition:alice')).toBeNull()
  })

  it('a second carry flushes an unclaimed first one rather than dropping it', () => {
    let first = 0
    carryVisit(visit({ key: 'edition:a' }), () => { first++ }, fakeTimers().timers)
    carryVisit(visit({ key: 'edition:b' }), () => {}, fakeTimers().timers)
    expect(first).toBe(1)
    expect(claimVisit('edition:b')).not.toBeNull()
  })

  it('the reader hands the visit over on every chapter change, and the session does not submit it twice', () => {
    // Hooks do not run under this test lane, so the wiring is pinned in the source.
    const shell = readFileSync(join(__dirname, '../components/reader/ReaderShell.tsx'), 'utf8')
    expect(shell).toMatch(/const navigateChapter = [\s\S]*?handOffSession\(\)[\s\S]*?carryVisit\([\s\S]*?onNavigateChapter\(slug\)/)
    expect(shell).toMatch(/useState\(\(\) => claimVisit\(visitKey\)\)/)
    const session = readFileSync(join(__dirname, '../hooks/useReadingSession.ts'), 'utf8')
    expect(session).toMatch(/if \(!handedOffRef\.current\) submit\(\)/)
  })
})
