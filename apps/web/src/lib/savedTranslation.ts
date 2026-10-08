/**
 * A saved word's translation is the sense of the sentence it was saved in. Write a
 * same-language translation into it unless the stored sentence is known AND is another one.
 * Unknown → write: the server ships no sentence for a word that has a translation, so
 * blocking on unknown would freeze every server-loaded word. A change of target language
 * is not a same-language write — callers write it unconditionally (language beats sense).
 */
export function mayWriteSavedTranslation(
  entry: { translation?: string; sentence?: string },
  bubbleSentence: string | undefined,
): boolean {
  if (!entry.translation || !entry.sentence) return true
  return entry.sentence.trim() === (bubbleSentence ?? '').trim()
}
