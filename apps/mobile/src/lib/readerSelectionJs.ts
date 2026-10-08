/**
 * Ends the WebView selection (readerBridge `__tsClearSelection`): drops the native range and the
 * word mark, unless `token` is no longer the WebView's current selection. `markOnly` keeps the range.
 */
export function clearSelectionJs(token: number | undefined, markOnly = false): string {
  return `try{window.__tsClearSelection&&window.__tsClearSelection(${typeof token === 'number' ? token : 'null'},${markOnly})}catch(e){}`
}
