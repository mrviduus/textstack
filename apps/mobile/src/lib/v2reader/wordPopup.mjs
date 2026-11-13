// The word popup and the selection toolbar (#1269): the hosts' read of `word` and `opened.lang`, and what a page
// message does to what is open. Pure, both hosts. The page renders untrusted book content: a host takes a word only
// through `readWord`, a language only through `readLang`.
import { MAX_SELECTION_CFI, MAX_SELECTION_INDEX, MAX_SELECTION_SENTENCE, readRect } from './selection.mjs'
import { tapAction } from './tapZone.mjs'

/** One token of the page's tokenizer; anything this long did not come from it. */
export const MAX_WORD = 100

/** A host's read of `word`: `{ index, word, sentence, cfi, rect }` fresh, or null (dropped). Never throws. */
export function readWord(m) {
  if (!m || typeof m !== 'object' || m.type !== 'word') return null
  const { index, word, sentence, cfi } = m
  if (!Number.isInteger(index) || index < 0 || index > MAX_SELECTION_INDEX) return null
  if (typeof word !== 'string' || word.length > MAX_WORD || !/\S/.test(word)) return null
  if (typeof sentence !== 'string' || sentence.length > MAX_SELECTION_SENTENCE) return null
  if (cfi !== null && !(typeof cfi === 'string' && cfi.length <= MAX_SELECTION_CFI && cfi.startsWith('epubcfi('))) return null
  const rect = readRect(m.rect)
  return rect && { index, word, sentence, cfi, rect }
}

/**
 * `opened.lang`: the book's language as its primary subtag, lower case (`en` of `en-GB`), or null: missing, `und`,
 * or not a language tag. The host falls back to its own default (the legacy readers': web `en`, Android the app's).
 */
export function readLang(m) {
  const l = m?.lang
  if (typeof l !== 'string' || !/^[a-z]{2,3}([-_][a-z0-9]{1,8})*$/i.test(l)) return null
  const primary = l.split(/[-_]/)[0].toLowerCase()
  return primary === 'und' ? null : primary
}

/**
 * What a page event does to what is open (`popup`: null, `{ kind: 'word', …readWord }` or `{ kind: 'selection',
 * …readSelection }`) and to the chrome (`turn`: tapZone's 'prev' / 'next' / 'toggle', or null). `zone`: tapAction's
 * `{ width, flow, dir }`. Events: `{ type: 'word', word }`, `{ type: 'tap', x }`, `{ type: 'selection', selection }`,
 * `{ type: 'selection-cleared' }`, `{ type: 'moved' }` (a relocate with `moved`).
 * - A word on an edge in paginated flow turns the page, as a tap there would: page turning stays reliable on text.
 *   Anywhere else (the centre, scrolled flow) it opens its popup, replacing what was open.
 * - A tap closes what is open; an edge still turns, a centre tap does nothing more (it was the dismissal).
 * - A selection replaces what is open (a double-click is `word`, then `selection`).
 * - `selection-cleared` closes the toolbar, never a word popup; a move closes a word popup (its word left the
 *   place it points at), never the toolbar (the page sends the selection again where it moved, or clears it).
 */
export function popupStep(popup, e, zone) {
  switch (e.type) {
    case 'word': {
      const { x, w } = e.word.rect
      const turn = tapAction({ ...zone, x: x + w / 2 })
      return turn === 'toggle' ? { popup: { kind: 'word', ...e.word }, turn: null } : { popup: null, turn }
    }
    case 'tap': {
      const turn = tapAction({ ...zone, x: e.x })
      return { popup: null, turn: popup && turn === 'toggle' ? null : turn }
    }
    case 'selection':
      return { popup: { kind: 'selection', ...e.selection }, turn: null }
    case 'selection-cleared':
      return { popup: popup?.kind === 'selection' ? null : popup, turn: null }
    case 'moved':
      return { popup: popup?.kind === 'word' ? null : popup, turn: null }
  }
  return { popup, turn: null }
}
