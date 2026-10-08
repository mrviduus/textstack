import { describe, it, expect, vi } from 'vitest'
import { clearSelectionJs } from './readerSelectionJs'

/** Runs the injected string against a fake window. */
function run(js: string, win: Record<string, unknown>) {
  new Function('window', js)(win)
}

describe('clearSelectionJs — the one way RN ends the WebView selection', () => {
  it('hands the token (and markOnly) to the bridge', () => {
    const clear = vi.fn()
    run(clearSelectionJs(7), { __tsClearSelection: clear })
    expect(clear).toHaveBeenCalledWith(7, false)
    run(clearSelectionJs(8, { markOnly: true }), { __tsClearSelection: clear })
    expect(clear).toHaveBeenLastCalledWith(8, true)
  })

  it('no token: null, so the bridge clears whatever is there', () => {
    const clear = vi.fn()
    run(clearSelectionJs(undefined), { __tsClearSelection: clear })
    expect(clear).toHaveBeenCalledWith(null, false)
  })

  it('a page without the bridge (the PDF viewer) just drops its range — unless asked for the mark only', () => {
    const removeAllRanges = vi.fn()
    const win = { getSelection: () => ({ removeAllRanges }) }
    run(clearSelectionJs(3), win)
    expect(removeAllRanges).toHaveBeenCalledTimes(1)
    run(clearSelectionJs(3, { markOnly: true }), win)
    expect(removeAllRanges).toHaveBeenCalledTimes(1)
  })
})
