import { parsePdfPageLocator } from '@textstack/shared'
import { writePdfPage } from './originalLayoutPref'
import type { V2WriteOutcome } from '../api/v2'
import type { UserBookProgress } from '../api/userBooks'

/**
 * What every V2 reading-state write does with its answer (#1025): a replaced file reloads the
 * book; a lost write's PDF page becomes the PDF view's own page. Returns the adopted place (reflow
 * or PDF) for the caller's state, else null. A legacy write answers nothing: null.
 */
export function applyV2Outcome(bookId: string, outcome: V2WriteOutcome | void): UserBookProgress | null {
  if (outcome === 'reload') {
    window.location.reload()
    return null
  }
  if (!outcome || typeof outcome === 'string') return null
  const page = parsePdfPageLocator(outcome.adopted.locator)
  if (page != null) writePdfPage(bookId, page)
  return outcome.adopted
}
