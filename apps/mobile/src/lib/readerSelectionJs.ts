/**
 * Ends the WebView selection (readerBridge `__tsClearSelection`): drops the native range and the
 * word mark, unless `token` is no longer the WebView's current selection. `markOnly` keeps the range,
 * and without a token is a no-op: it can't tell its own mark from a newer one (SEL-1).
 */
export function clearSelectionJs(token: number | undefined, markOnly = false): string {
  if (markOnly && typeof token !== 'number') return ''
  return `try{window.__tsClearSelection&&window.__tsClearSelection(${typeof token === 'number' ? token : 'null'},${markOnly})}catch(e){}`
}
