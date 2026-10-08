/**
 * Paint vocab underlines, if the loaded document can. The PDF viewer document has no
 * markVocabWords, and during a document swap the old one is still loaded; onLoadEnd repaints
 * from the same map once the reflow document is ready, so skipping here loses nothing.
 */
export function vocabPaintJs(map: object): string {
  return `typeof markVocabWords === 'function' && markVocabWords(${JSON.stringify(map)})`
}
