import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TextPosition } from '@textstack/shared'
import { rebuildRestoreJs, rebuildRestoreTarget } from './rebuildRestore'

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

describe('L1 / M6 wiring', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')
  const persistence = read('src/hooks/useReaderPersistence.ts')
  const shell = read('src/components/reader/ReaderShell.tsx')

  it('the target is snapshotted when the rebuild STARTS — before the load event zeroes the percent', () => {
    const start = persistence.indexOf('const onDocumentRebuild = useCallback(')
    const body = persistence.slice(start, persistence.indexOf('}, [', start))
    expect(body).toContain('rebuildTargetRef.current = rebuildRestoreTarget(positionRef.current, progressRef.current')
  })

  it('a rebuilt document restores through the anchor-first target, not a bare percent', () => {
    const start = persistence.indexOf('const onWebViewLoaded = useCallback(')
    const body = persistence.slice(start, persistence.indexOf('readiness({ type: \'webViewLoaded\' })', start))
    expect(body).toContain('rebuildRestoreJs(target, restoreId)')
    expect(body).not.toContain('__textstackRestorePercent')
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
