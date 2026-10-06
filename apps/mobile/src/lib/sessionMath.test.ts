import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applySessionProgress, jumpDistance, sessionWordsRead, tickSeconds, MAX_TICK_SECONDS } from './sessionMath'

const IDLE = 180_000

describe('tickSeconds (L2, L5)', () => {
  it('credits the partial tick since the last heartbeat', () => {
    expect(tickSeconds({ now: 17_000, lastTick: 0, lastActivity: 10_000, idleMs: IDLE })).toBe(17)
  })

  it('credits nothing when the reader has been idle', () => {
    expect(tickSeconds({ now: 200_000, lastTick: 190_000, lastActivity: 0, idleMs: IDLE })).toBe(0)
  })

  it('a clock set BACK never subtracts reading time', () => {
    expect(tickSeconds({ now: 1_000, lastTick: 600_000, lastActivity: 1_000, idleMs: IDLE })).toBe(0)
  })

  it('a clock set FORWARD credits at most one bounded tick', () => {
    expect(tickSeconds({ now: 3_600_000, lastTick: 0, lastActivity: 3_600_000, idleMs: IDLE })).toBe(MAX_TICK_SECONDS)
  })
})

describe('applySessionProgress (M8)', () => {
  const fresh = { start: 0, current: 0, baselined: false }

  it('the first settled report is the baseline — a reopen at 45% counts nothing yet', () => {
    expect(applySessionProgress(fresh, 0.45)).toEqual({ start: 0.45, current: 0.45, baselined: true })
  })

  it('later reports move only the end', () => {
    const s = applySessionProgress(applySessionProgress(fresh, 0.45), 0.5)
    expect(s).toEqual({ start: 0.45, current: 0.5, baselined: true })
  })

  it('a book genuinely at 0% keeps its baseline (the old 0 && 0 check re-baselined it)', () => {
    const s = applySessionProgress(applySessionProgress(fresh, 0), 0.02)
    expect(s.start).toBe(0)
    expect(s.current).toBe(0.02)
  })
})

describe('programmatic jumps are not reading (review #2)', () => {
  it('device at 10%, other device at 60%: the jump counts nothing, the reading after it counts', () => {
    const W = 100_000
    const start = 0.1
    let jumped = 0
    jumped += jumpDistance(0.1, 0.6)          // the restore to the newer position lands at 60%
    expect(sessionWordsRead({ start, current: 0.6, jumped, wordCount: W })).toBe(0)
    expect(sessionWordsRead({ start, current: 0.62, jumped, wordCount: W })).toBe(2_000)
  })

  it('reading before the jump is kept', () => {
    // read 10% → 15%, then jumped to 60%, then read to 61%: 6% of the book
    const jumped = jumpDistance(0.15, 0.6)
    expect(sessionWordsRead({ start: 0.1, current: 0.61, jumped, wordCount: 100 })).toBe(6)
  })

  it('a landing with nothing fed yet is just the baseline', () => {
    expect(jumpDistance(null, 0.45)).toBe(0)
  })
})

describe('jump wiring (review #2)', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')
  const persistence = read('src/hooks/useReaderPersistence.ts')
  const feed = read('src/components/reader/useReaderSessionFeed.ts')

  it('every programmatic restore marks the session jump pending, in issueRestore', () => {
    const start = persistence.indexOf('const issueRestore = useCallback(')
    expect(persistence.slice(start, persistence.indexOf('}, [dispatchGate])', start))).toContain("sessionJumpRef.current = 'pending'")
    // goHere / applyNewer / the toast / a rebuild all restore through restoreTo → issueRestore, and
    // the typography reflow issues its own id the same way (R4).
    const body = (name: string) => {
      const at = persistence.indexOf(`const ${name} = useCallback(`)
      return persistence.slice(at, persistence.indexOf('}, [', at))
    }
    expect(body('injectSaved')).toContain('restoreTo(target)')
    expect(body('restoreTo')).toContain('issueRestore()')
    expect(body('reflow')).toContain('issueRestore()')
  })

  it('the ack (or the settle timeout) turns it into a landing', () => {
    const start = persistence.indexOf('const onRestoreLanded = useCallback(')
    expect(persistence.slice(start, start + 300)).toContain("sessionJumpRef.current = 'landed'")
  })

  it('the shell never feeds a pending restore, and feeds the landing as a jump', () => {
    expect(feed).toMatch(/sessionSettledRef\.current && jump !== 'pending'/)
    expect(feed).toContain("updateSessionProgress(bp, { jump: jump === 'landed' })")
  })
})

describe('session wiring (M8, L2)', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')
  const session = read('src/hooks/useReadingSession.ts')
  const feed = read('src/components/reader/useReaderSessionFeed.ts')

  it('submit credits the partial tick before it reads the duration', () => {
    const start = session.indexOf('const submit = useCallback(')
    const body = session.slice(start, session.indexOf('const duration', start))
    expect(body).toContain('if (!handedOffRef.current) creditTick()')
  })

  it('the heartbeat and the hand-off use the same clamped tick', () => {
    expect(session.match(/creditTick\(\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(session).not.toMatch(/Math\.min\(elapsed, 60\)/)
  })

  it('the shell feeds the session only reports after the restore settled', () => {
    expect(feed).toMatch(/if \(bp != null && sessionSettledRef\.current && jump !== 'pending'\)/)
    const ack = feed.indexOf("data.type === 'restored'")
    expect(feed.slice(ack, ack + 600)).toMatch(/sessionSettledRef\.current = true\s+onRestoreLanded/)
    expect(feed).toMatch(/if \(!positionSettled \|\| sessionSettledRef\.current\) return/)
  })

  it('both sources hand the settled flag to the shell', () => {
    for (const f of ['src/components/reader/useUserBookReaderSource.ts', 'src/components/reader/useEditionReaderSource.ts']) {
      expect(read(f)).toMatch(/reflow, positionSettled,/)
    }
  })
})
