/**
 * Ends the WebView selection (the engine pages' `__tsClearSelection`): drops the page's selection and
 * the held-word mark, unless `token` is no longer the WebView's current selection. `markOnly` (E47) keeps the selection,
 * and without a token is a no-op: it can't tell its own mark from a newer one (SEL-1).
 */
export function clearSelectionJs(token: number | undefined, markOnly = false): string {
  if (markOnly && typeof token !== 'number') return ''
  return `try{window.__tsClearSelection&&window.__tsClearSelection(${typeof token === 'number' ? token : 'null'},${markOnly})}catch(e){}`
}
