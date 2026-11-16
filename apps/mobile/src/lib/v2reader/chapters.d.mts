// Types for chapters.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const MAX_CHAPTER_TEXT_BYTES: number
export const MAX_CHAPTER_KEY: number
export const MAX_CHAPTER_TITLE: number
/** A place in the book a contents entry leads to: its spine section and its href (two places of one section differ by it). */
export interface V2ChapterPlace { sec: number; at: string; anchor: ((doc: Document) => unknown) | null }
/** The chapter whose end is on screen: a contents entry (`tocIndex`), or spine section `section` in a book with no contents. */
export interface V2ChapterEnd { tocIndex: number | null; section: number }
export type V2ChapterText = { request: string; text: string; cut: boolean } | { request: string; error: 'empty' | 'unavailable' }
export function placeOf(resolved: unknown, href: unknown, sections: number): V2ChapterPlace | null
export function chapterOf(places: readonly (V2ChapterPlace | null)[], tocIndex: number | null):
  { start: V2ChapterPlace; end: V2ChapterPlace | null } | null
export function chapterBefore(places: readonly (V2ChapterPlace | null)[], tocIndex: number | null): number | null
export function chapterKey(chapter: V2ChapterEnd): string
export function textBetween(doc: Document, from: Element | null, to: Element | null): string[]
export function fitText(paragraphs: readonly string[], cap?: number): { text: string; cut: boolean }
export function readChapterEnd(m: unknown): V2ChapterEnd | null
export function readChapterText(m: unknown): V2ChapterText | null
