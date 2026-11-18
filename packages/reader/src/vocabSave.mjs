// A vocabulary save's answer as the V2 reader's hosts act on it (#1270): the legacy readers' outcomes, one rule for
// both hosts. Pure. The save itself is the app's (web `useReaderVocabulary.addWord`, Android `vocabularyApi.saveWord`):
// on V2 it answers `srs` or `deleted`; `pending` and `lookup*` are legacy answers, kept as the legacy readers show them.
import { readLang } from './wordPopup.mjs'

/**
 * Whether a book's words may be saved, by its `opened` message: yes when `lang` reads (`readLang`) or is absent (the
 * host's fallback, as the legacy readers). No when it is there and does not read (`deu`, `fre`, junk): the fallback
 * would file the book's words under another language's cards. Translate and explain may still use the fallback.
 */
export function savesWords(opened) {
  const l = opened?.lang
  return l === undefined || l === null || l === '' || readLang(opened) !== null
}

/**
 * `resp`: the save's response (`SaveWordResponse`), or null (nothing came back: a failure, or a word kept on the
 * device until the guest session exists). One of:
 * - `{ kind: 'saved', word }`: a card (new, or the one already under that key);
 * - `{ kind: 'already_saved', word }`: legacy's re-save of a saved word (Android closes its bar; web as `saved`);
 * - `{ kind: 'deleted', id }`: the reader deleted this word earlier; its tombstone's id, for the restore offer;
 * - `{ kind: 'pending' }`: the daily cap queued it ("queued for tomorrow");
 * - `{ kind: 'lookup', lookup, id, tapsRemaining }`: a rare word kept as a lookup, "add anyway" promotes `id`;
 * - `{ kind: 'none' }`: nothing to show.
 */
export function saveOutcome(resp) {
  if (!resp || typeof resp !== 'object') return { kind: 'none' }
  switch (resp.outcome) {
    case 'deleted':
      return typeof resp.word?.id === 'string' ? { kind: 'deleted', id: resp.word.id } : { kind: 'none' }
    case 'pending':
      return { kind: 'pending' }
    case 'lookup':
    case 'lookup_pending':
      return typeof resp.lookupId === 'string'
        ? { kind: 'lookup', lookup: resp.outcome, id: resp.lookupId, tapsRemaining: resp.tapsRemaining ?? null }
        : { kind: 'none' }
    case 'already_saved':
      return { kind: 'already_saved', word: resp.word ?? null }
  }
  return resp.word ? { kind: 'saved', word: resp.word } : { kind: 'none' }
}
