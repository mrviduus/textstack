// Edge punctuation a drag selection can carry ("word,", "«word»"). No \p{…}: keeps Hermes out of it.
const EDGE = /^[\s"'“”‘’«»()[\]{}.,;:!?…—–-]+|[\s"'“”‘’«»()[\]{}.,;:!?…—–-]+$/g

/** The reader vocab map's key. Built from a saved word and looked up from a selection with this one
 *  function, so "Pocketed," and "don’t" find "pocketed" and "don't". */
export function vocabMapKey(text: string): string {
  return text.normalize('NFC').replace(/’/g, "'").toLowerCase().replace(EDGE, '')
}
