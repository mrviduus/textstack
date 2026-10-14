// The word-key rules live in shared: the reader engine marks saved words with the same tokenizer.
export { extractVocabKey, normalizeVocabKey, tokenizeVocabWords } from '@textstack/shared'

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
