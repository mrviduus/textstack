/**
 * End the WebView's selection — the one helper every caller uses.
 *
 * The reflow reader's bridge (`readerBridge.ts`, `__tsClearSelection`) drops the native range and
 * unwraps the long-press word mark, but only if `token` is still its current selection: a late clear
 * must not wipe a newer one. `markOnly` keeps the native range (the highlight paint). A page without
 * the bridge — the Original PDF viewer, which has no word mark — only has a range to drop.
 */
export function clearSelectionJs(token: number | undefined, opts: { markOnly?: boolean } = {}): string {
  const t = typeof token === 'number' ? String(token) : 'null'
  const markOnly = opts.markOnly ? 'true' : 'false'
  return `try{if(window.__tsClearSelection){window.__tsClearSelection(${t},${markOnly})}else if(!${markOnly}&&window.getSelection){window.getSelection().removeAllRanges()}}catch(e){}`
}
