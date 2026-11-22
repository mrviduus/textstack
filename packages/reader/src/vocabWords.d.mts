// Types for vocabWords.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
import type { MarkWord } from './wordMarks.mjs'

export function langOf(tag: unknown): string | null
export function ofBook(cardLanguage: unknown, bookLanguage: unknown): boolean
export function wordId(key: (word: string) => string, word: string, language: string | null | undefined): string
export function markWordsOf(entries: { word: string; stage: number; translation?: string | null }[]): MarkWord[]
export function backfillTranslations(
  words: readonly { id: string; word: string }[],
  from: string | null,
  to: string | null,
  io: {
    translate: (word: string) => Promise<string | null>
    persist: (id: string, translation: string) => Promise<unknown>
    onWord: (id: string, translation: string) => void
    cancelled: () => boolean
  },
): Promise<void>
