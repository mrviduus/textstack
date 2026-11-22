// Types for chapters.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const MAX_CHAPTER_TEXT_BYTES: number
export const MAX_CHAPTER_KEY: number
export const MAX_CHAPTER_TITLE: number
/** A place in the book a contents entry leads to: its spine section and its href (two places of one section differ by it). */
export interface ChapterPlace { sec: number; at: string; top: boolean; anchor: ((doc: Document) => unknown) | null }
/** The chapter whose end is on screen: a contents entry (`tocIndex`), or spine section `section` in a book with no contents; `title` as the page read it. */
export interface ChapterEnd { tocIndex: number | null; section: number; title: string | null }
export interface ChapterStart { owner: number; members: number[]; el: Element | null }
export interface ChapterSegment { owner: number | null; from: Element | null; to: Element | null; last: boolean }
export type ChapterText = { request: string; text: string; cut: boolean } | { request: string; error: 'empty' | 'unavailable' }
export function placeOf(resolved: unknown, href: unknown, sections: number): ChapterPlace | null
export function startsIn(places: readonly (ChapterPlace | null)[], sec: number, doc: Document): ChapterStart[]
export function fileSummary(places: readonly (ChapterPlace | null)[], sec: number, doc: Document): { owners: number[]; top: boolean }
export function segmentsIn(groups: readonly ChapterStart[], carry: number | null): ChapterSegment[]
export function hasContents(places: readonly (ChapterPlace | null)[]): boolean
export function chapterKey(chapter: { tocIndex: number | null; section: number }): string
export function textBetween(doc: Document, from: Element | null, to: Element | null): string[]
export function fitText(paragraphs: readonly string[], cap?: number): { text: string; cut: boolean }
export function offersDiscuss(chapterEnd: ChapterEnd | null): boolean
export function readChapterEnd(m: unknown): ChapterEnd | null
export function readChapterText(m: unknown): ChapterText | null
