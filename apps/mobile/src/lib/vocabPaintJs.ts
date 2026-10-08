/**
 * Paint vocab underlines, if the loaded document can. The PDF viewer document has no
 * markVocabWords, and during a document swap the old one is still loaded; onLoadEnd repaints
 * from the same map once the reflow document is ready, so skipping here loses nothing.
 */
export function vocabPaintJs(map: Record<string, { stage: number; translation?: string }>): string {
  // Only what markVocabWords reads (readerHtml.ts): stage + translation. Not id, not sentence.
  const paint: Record<string, { stage: number; translation?: string }> = {}
  for (const k of Object.keys(map)) paint[k] = { stage: map[k].stage, translation: map[k].translation }
  return `typeof markVocabWords === 'function' && markVocabWords(${JSON.stringify(paint)})`
}
