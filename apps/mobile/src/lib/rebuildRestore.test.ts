import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TextPosition } from '@textstack/shared'
import { duringRestorePlan, rebuildRestoreJs, rebuildRestoreTarget, savedRestoreTarget } from './rebuildRestore'
import { READINESS_INITIAL, readinessReduce, readyToRestore, type Readiness, type ReadinessEvent } from './restoreReadiness'
import { canPersistPosition, restoreGateReduce, restoredChapter, RESTORE_GATE_INITIAL, type RestoreGateEvent } from './readerWriteGate'

const pos = (chapterSlug: string) => ({ chapterSlug, quote: 'It was', charOffset: 120 } as unknown as TextPosition)

describe('rebuildRestoreTarget (L1)', () => {
  it('the text anchor wins over the percent — it is what survives a new font face', () => {
    expect(rebuildRestoreTarget(pos('ch-2'), 0.4, 'ch-2')).toEqual({ kind: 'anchor', position: pos('ch-2') })
  })

  it("an anchor from another chapter is not this chapter's place → percent", () => {
    expect(rebuildRestoreTarget(pos('ch-1'), 0.4, 'ch-2')).toEqual({ kind: 'percent', percent: 0.4 })
  })

  it('nothing saved, or the top → no restore', () => {
    expect(rebuildRestoreTarget(null, 0, 'ch-2')).toBeNull()
    expect(rebuildRestoreTarget(null, NaN, 'ch-2')).toBeNull()
  })

  it('the injection carries the restore id either way', () => {
    expect(rebuildRestoreJs({ kind: 'anchor', position: pos('ch-2') }, 7)).toMatch(/__textstackRestoreAnchor\(".*", 7\)$/)
    expect(rebuildRestoreJs({ kind: 'percent', percent: 0.4 }, 8)).toMatch(/__textstackRestorePercent\(0\.4, 8\)$/)
    expect(rebuildRestoreJs(null, 9)).toBeNull()
  })
})

describe('savedRestoreTarget — the open restore, anchor → offset → percent', () => {
  it('picks the first one saved, and null only when nothing is', () => {
    expect(savedRestoreTarget({ position: pos('ch-2'), offset: 900, percent: 0.4 })).toEqual({ kind: 'anchor', position: pos('ch-2') })
    expect(savedRestoreTarget({ position: null, offset: 900, percent: 0.4 })).toEqual({ kind: 'offset', offset: 900 })
    expect(savedRestoreTarget({ position: null, offset: null, percent: 0 })).toEqual({ kind: 'percent', percent: 0 })
    expect(savedRestoreTarget({ position: null, offset: null, percent: null })).toBeNull()
  })

  it('an offset target restores through __textstackRestoreScroll', () => {
    expect(rebuildRestoreJs({ kind: 'offset', offset: 900 }, 3)).toMatch(/__textstackRestoreScroll\(900, 3\)$/)
  })
})

/**
 * ADR-019 rule 8: a rebuild or reflow during a restore keeps the pending target.
 *
 * Reader settings load from AsyncStorage after the first render, so a reader with OpenDyslexic gets a
 * rebuild on every open — usually while the open restore is still in flight. The live refs then hold
 * the load event's values (percent 0, no position), and snapshotting them restored to the top and
 * saved 0 over the reader's place.
 */
describe('duringRestorePlan — rule 8', () => {
  const live = rebuildRestoreTarget(null, 0, 'ch-2')  // the load event's values: top, nothing
  const saved = { kind: 'anchor', position: pos('ch-2') } as const

  it.each([
    ['restore in flight → its target, not the live refs', { restoreFired: true, pendingTarget: saved, live }, { kind: 'keepPending', target: saved }],
    ['restore landed → where the reader is now', { restoreFired: true, pendingTarget: undefined, live: saved }, { kind: 'snapshot', target: saved }],
    ['restore not asked yet → the restore itself runs on the new document', { restoreFired: false, pendingTarget: undefined, live }, { kind: 'awaitRestore' }],
    ['a pending "top" is still a target (null), not "nothing pending"', { restoreFired: true, pendingTarget: null, live: saved }, { kind: 'keepPending', target: null }],
  ] as const)('%s', (_name, input, expected) => {
    expect(duringRestorePlan(input)).toEqual(expected)
  })

  it('open at a saved place, rebuild before the ack → the rebuild restores the saved place and nothing is saved before it lands', () => {
    let r: Readiness = READINESS_INITIAL
    const ready = (e: ReadinessEvent) => { r = readinessReduce(r, e) }
    let g = RESTORE_GATE_INITIAL
    const gate = (e: RestoreGateEvent) => { g = restoreGateReduce(g, e) }
    const canSave = () => canPersistPosition({ enabled: true, bookKey: 'b', chapterSlug: 'ch-2', restoredFor: restoredChapter(g) })

    ready({ type: 'opened', doc: 'true:ch-2' }); gate({ type: 'chapterEntered', chapterSlug: 'ch-2' })
    ready({ type: 'positionLoaded' }); ready({ type: 'webViewLoaded' })
    expect(readyToRestore(r)).toBe(true)
    ready({ type: 'restoreFired' })
    const pending = savedRestoreTarget({ position: pos('ch-2'), offset: null, percent: null })
    gate({ type: 'restoreIssued', restoreId: 1, at: 0 })

    // Settings land: OpenDyslexic → rebuild, before the WebView acked restore 1.
    const plan = duringRestorePlan({ restoreFired: r.restored, pendingTarget: pending, live })
    expect(plan).toEqual({ kind: 'keepPending', target: saved })
    gate({ type: 'chapterEntered', chapterSlug: 'ch-2' })
    gate({ type: 'positionReported', scrollY: 0 })           // the new document's load event
    gate({ type: 'restoreLanded', restoreId: 1 })            // the dead document's late ack
    expect(canSave()).toBe(false)

    // New document loaded → restore 2 to the plan's target.
    const js = rebuildRestoreJs(plan.kind === 'awaitRestore' ? null : plan.target, 2)
    expect(js).toContain('__textstackRestoreAnchor')
    expect(js).toContain('It was')
    gate({ type: 'restoreIssued', restoreId: 2, at: 0 })
    expect(canSave()).toBe(false)
    gate({ type: 'restoreLanded', restoreId: 2 })
    expect(canSave()).toBe(true)
  })

  it('rebuild before the position is read → the new document waits for it, the old one is not restored', () => {
    let r = ([{ type: 'opened', doc: 'true:ch-2' }, { type: 'webViewLoaded' }] as ReadinessEvent[]).reduce(readinessReduce, READINESS_INITIAL)
    expect(duringRestorePlan({ restoreFired: r.restored, pendingTarget: undefined, live })).toEqual({ kind: 'awaitRestore' })
    r = readinessReduce(r, { type: 'documentReplaced' })
    r = readinessReduce(r, { type: 'positionLoaded' })
    expect(readyToRestore(r)).toBe(false)                    // not into the document being replaced
    expect(readyToRestore(readinessReduce(r, { type: 'webViewLoaded' }))).toBe(true)
  })
})

describe('L1 / M6 wiring', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')
  const persistence = read('src/hooks/useReaderPersistence.ts')
  const shell = read('src/components/reader/ReaderShell.tsx')

  it('the target is decided when the rebuild STARTS — pending target first, else a live snapshot', () => {
    const start = persistence.indexOf('const onDocumentRebuild = useCallback(')
    const body = persistence.slice(start, persistence.indexOf('}, [', start))
    expect(body).toContain('duringRestorePlan(')
    expect(body).toContain('rebuildRestoreTarget(positionRef.current, progressRef.current')
    expect(body).toContain("readiness({ type: 'documentReplaced' })")
  })

  it('rule 8: a reflow during a restore re-issues the pending target after the typography', () => {
    const start = persistence.indexOf('const reflow = useCallback(')
    const body = persistence.slice(start, persistence.indexOf('}, [', start))
    expect(body).toContain('duringRestorePlan(')
    expect(body).toMatch(/injectJs\(buildJs\(issueRestore\(\)\)\)[\s\S]*restoreTo\(plan\.target\)/)
    expect(shell).toContain('reflow(id => readerTypographyInjectionJs(next, id))')
  })

  it('rule 8: typography that changed before the document loaded is applied at load, after the restore is asked', () => {
    const start = shell.indexOf('onLoadEnd={() => {')
    const body = shell.slice(start, shell.indexOf('originWhitelist', start))
    expect(body.indexOf('onWebViewLoaded()')).toBeGreaterThan(-1)
    expect(body.indexOf('applyTypography()')).toBeGreaterThan(body.indexOf('onWebViewLoaded()'))
  })

  it('a rebuilt document restores through the anchor-first target, not a bare percent', () => {
    const start = persistence.indexOf('const onWebViewLoaded = useCallback(')
    const body = persistence.slice(start, persistence.indexOf('readiness({ type: \'webViewLoaded\' })', start))
    expect(body).toContain('restoreTo(target)')
    expect(body).not.toContain('__textstackRestorePercent')
    const at = persistence.indexOf('const restoreTo = useCallback(')
    expect(persistence.slice(at, persistence.indexOf('}, [', at))).toContain('rebuildRestoreJs(target, restoreId)')
  })

  it('M6: a dead renderer remounts the WebView (new key) on both platforms, at the saved place', () => {
    expect(shell).toContain('onRenderProcessGone={onRendererGone}')
    expect(shell).toContain('onContentProcessDidTerminate={onRendererGone}')
    expect(shell).toContain('key={webViewKey}')
    const start = shell.indexOf('const onRendererGone = useCallback(')
    const body = shell.slice(start, shell.indexOf('}, [', start))
    expect(body).toContain('onDocumentRebuild()')
    expect(body).toContain('pdfIsReloadRef.current = true')
    expect(body).toContain('pdfInitialPageRef.current = currentPdfPageRef.current')
  })

  it('M6: the remounted document is rebuilt with current typography', () => {
    expect(shell).toContain('[documentKey, webViewKey]')
    expect(shell).toContain('nonce: pdfReloadNonce + webViewKey')
  })
})
