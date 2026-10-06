import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applySessionProgress, tickSeconds, MAX_TICK_SECONDS } from './sessionMath'

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

describe('session wiring (M8, L2)', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')
  const session = read('src/hooks/useReadingSession.ts')
  const shell = read('src/components/reader/ReaderShell.tsx')

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
    expect(shell).toMatch(/if \(bp != null && sessionSettledRef\.current\) updateSessionProgress\(bp\)/)
    const ack = shell.indexOf("data.type === 'restored'")
    expect(shell.slice(ack, ack + 600)).toMatch(/sessionSettledRef\.current = true\s+onRestoreLanded/)
    expect(shell).toMatch(/if \(!positionSettled \|\| sessionSettledRef\.current\) return/)
  })

  it('both sources hand the settled flag to the shell', () => {
    for (const f of ['src/components/reader/useUserBookReaderSource.ts', 'src/components/reader/useEditionReaderSource.ts']) {
      expect(read(f)).toMatch(/beginReflow, positionSettled,/)
    }
  })
})
