import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gateOpened, restoreGateReduce, RESTORE_GATE_INITIAL, type RestoreGateState } from './readerWriteGate'

/**
 * R4: the restore ack's scrollY (bug 4). Bug 3 (the foreground check across a renderer kill) and
 * review #2 (a rebuild keeps the pending target) are behaviour tests in
 * hooks/useReaderPersistence.test.ts; rule 8 is in rebuildRestore.test.ts, the PDF start page in
 * pdfInitialJump.test.ts.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
const persistence = read('src/hooks/useReaderPersistence.ts')
const feed = read('src/components/reader/useReaderSessionFeed.ts')
const doc = read('src/components/reader/useReaderDocument.ts')
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

// Kept as guards until a behaviour test exists (#873: the persistence harness does not yet catch a
// lost landingBaseline, and the WebView source switch needs the PDF → text path mounted).
describe('bug 4 — the restore ack carries the landing', () => {
  // The page half (the ack carries scrollY, then the landing is reported): readerEnginePage.test.ts.
  it("persistence takes the ack's scrollY as the move baseline; the shell passes it", () => {
    const landed = body(persistence, 'const onRestoreLanded = useCallback(')
    expect(landed).toContain('moveBaselineRef.current = landingBaseline(moveBaselineRef.current, scrollY)')
    expect(feed).toContain('onRestoreLanded(data.restoreId, data.scrollY)')
  })

  it('review #3: a new WebView source (PDF → "Read as text") resets the loaded flag and the applied typography', () => {
    const eff = body(doc, 'useEffect(() => {\n    docLoadedRef.current = false', '}, [webViewSource])')
    expect(eff).toContain('readerAppliedTypographyRef.current = builtTypographyRef.current')
    // Before the typography effect, so a change in the same render waits for onLoadEnd.
    expect(doc.indexOf('}, [webViewSource])')).toBeLessThan(doc.indexOf('useEffect(() => { applyTypography() }'))
  })
})
