import { READER_GLOSS_SELECTOR } from '@textstack/shared'

// Single source of truth for "what counts as a vocabulary word key".
// Covers: Unicode letters/marks/numbers + straight & curly apostrophes + hyphens.
// Always NFC-normalized + lowercased.
const WORD_RE = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’\-]*/u
const WORD_RE_G = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’\-]*/gu

/** Extract the first word-like token from arbitrary text (e.g. selection.text). */
export function extractVocabKey(text: string): string | null {
  if (!text) return null
  const m = text.normalize('NFC').match(WORD_RE)
  return m ? m[0].toLowerCase() : null
}

/** Normalize an already-token string (e.g. map key or entry word). */
export function normalizeVocabKey(word: string): string {
  return word.normalize('NFC').toLowerCase()
}

/** Tokenize a full text (for VocabWordLayer underlining). */
export function tokenizeVocabWords(text: string): { word: string; start: number; end: number }[] {
  const tokens: { word: string; start: number; end: number }[] = []
  const src = text.normalize('NFC')
  let m: RegExpExecArray | null
  WORD_RE_G.lastIndex = 0
  while ((m = WORD_RE_G.exec(src)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length })
  }
  return tokens
}

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
