import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gateOpened, restoreGateReduce, RESTORE_GATE_INITIAL, type RestoreGateState } from './readerWriteGate'

/**
 * R4: the foreground check across a renderer kill (bug 3) and the restore ack's scrollY (bug 4).
 * Rule 8 (rebuild/reflow during a restore) is in rebuildRestore.test.ts, the PDF start page in
 * pdfInitialJump.test.ts.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
const persistence = read('src/hooks/useReaderPersistence.ts')
const shell = read('src/components/reader/ReaderShell.tsx')
const html = read('src/lib/readerHtml.ts')
const body = (src: string, from: string, to = '}, [') => {
  const start = src.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf(to, start))
}

describe('gateOpened — the edge a deferred foreground check waits for', () => {
  const issued: RestoreGateState = restoreGateReduce(
    restoreGateReduce(RESTORE_GATE_INITIAL, { type: 'chapterEntered', chapterSlug: 'ch-1' }),
    { type: 'restoreIssued', restoreId: 4, at: 0 },
  )
  it('fires on issued → open (ack, timeout, standby), not on open → open or a stale ack', () => {
    const landed = restoreGateReduce(issued, { type: 'restoreLanded', restoreId: 4 })
    expect(gateOpened(issued, landed)).toBe(true)
    expect(gateOpened(issued, restoreGateReduce(issued, { type: 'restoreTimedOut', restoreId: 4 }))).toBe(true)
    expect(gateOpened(landed, landed)).toBe(false)
    expect(gateOpened(issued, restoreGateReduce(issued, { type: 'restoreLanded', restoreId: 3 }))).toBe(false)
  })
})

describe('bug 3 — back in the foreground during a rebuild or restore (M6 remount)', () => {
  it('the check waits for the restore to land instead of skipping or running against the load event', () => {
    const listener = body(persistence, "AppState.addEventListener('change'", 'return () => sub.remove()')
    expect(listener).not.toContain('!readinessRef.current.restored')
    expect(listener).toContain('whenLanded(')
    // An answer that arrives mid-rebuild waits too.
    expect(listener).toMatch(/\.then\(newer => \{[\s\S]*whenLanded\(/)
  })

  it('the deferred check runs on the gate opening, with the landing as the move baseline', () => {
    const dispatch = body(persistence, 'const dispatchGate = useCallback(')
    expect(dispatch).toContain('gateOpened(prev, gateRef.current)')
    expect(dispatch).toContain('afterLandRef.current')
  })
})

describe('bug 4 — the restore ack carries the landing', () => {
  it('the ack posts a chapter-relative scrollY and is followed by a forced progress report', () => {
    const ack = body(html, 'function ackRestore(restoreId)', '\n    }\n')
    expect(ack).toContain('currentChapterBounds()')
    expect(ack).toMatch(/lastProgress = -1;\s*reportProgress\(\);/)
    expect(ack.indexOf('reportProgress()')).toBeGreaterThan(ack.indexOf("type: 'restored'"))
  })

  it("persistence takes the ack's scrollY as the move baseline; the shell passes it", () => {
    const landed = body(persistence, 'const onRestoreLanded = useCallback(')
    expect(landed).toMatch(/moveBaselineRef\.current = scrollY/)
    expect(shell).toContain('onRestoreLanded(data.restoreId, data.scrollY)')
  })

  it('the ponytail ceiling on a silent landing is gone', () => {
    expect(shell).not.toContain('a restore that lands without moving >0.5% posts no report')
  })
})
