import { READER_GLOSS_SELECTOR, tokenizeVocabWords } from '@textstack/shared'

// The word-key rules live in shared: the reader engine marks saved words with the same tokenizer.
export { extractVocabKey, normalizeVocabKey, tokenizeVocabWords } from '@textstack/shared'

/**
 * Extract the selected word from a live Range, skipping `.vocab-inline-translation`
 * spans. Needed when user selects a saved word whose mark contains both the word
 * text and the translation text — `range.toString()` returns them concatenated
 * (no whitespace between scripts), which the tokenizer can't split.
 *
 * Returns the first word-token of the filtered text, or null if nothing usable.
 */
/** Text of a detached node / fragment without the reader's own gloss nodes (removes them in place). */
export function textWithoutGloss(n: Node): string {
  if (n instanceof Element || n instanceof DocumentFragment) n.querySelectorAll(READER_GLOSS_SELECTOR).forEach((g) => g.remove())
  return n.textContent ?? ''
}

export function extractWordFromRange(range: Range | null): string | null {
  if (!range) return null
  const frag = range.cloneContents()
  const text = textWithoutGloss(frag)
  if (!text.trim()) return null
  const tokens = tokenizeVocabWords(text)
  return tokens.length > 0 ? tokens[0].word : text.trim()
}

/** CSS class per SRS stage for vocab-underline coloring. Single source for all readers. */
export const STAGE_CLASSES: Record<number, string> = {
  0: 'vocab-underline--new',
  1: 'vocab-underline--recognition',
  2: 'vocab-underline--recall',
  3: 'vocab-underline--context',
  4: 'vocab-underline--mastered',
}

/** Resolve the stage-specific underline class, falling back to "new" for unknown stages. */
export function vocabStageClass(stage: number): string {
  return STAGE_CLASSES[stage] ?? STAGE_CLASSES[0]
}
