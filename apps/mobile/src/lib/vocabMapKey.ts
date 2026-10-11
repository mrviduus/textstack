// Edge punctuation a drag selection can carry ("word,", "«word»"). No \p{…}: keeps Hermes out of it.
const EDGE = /^[\s"'“”‘’«»()[\]{}.,;:!?…—–-]+|[\s"'“”‘’«»()[\]{}.,;:!?…—–-]+$/g

/** The reader vocab map's key. Built from a saved word and looked up from a selection with this one
 *  function, so "Pocketed," and "don’t" find "pocketed" and "don't". */
export function vocabMapKey(text: string): string {
  return text.normalize('NFC').replace(/’/g, "'").toLowerCase().replace(EDGE, '')
}

/** A map cached before vocabMapKey existed is keyed by `toLowerCase()`; re-key it on load. */
export function rekeyVocabMap<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [vocabMapKey(k), v]))
}
