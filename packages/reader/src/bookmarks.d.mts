// Types for bookmarks.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
import type { ListItem } from './highlights.mjs'

/** An entry highlight or a V2 annotation of colour `BOOKMARK_COLOR` (`packages/shared`). */
export function isBookmark(h: { color?: string | null } | null | undefined): boolean
export const BOOKMARK_TEXT: number
export function bookmarkRange(visible: Range | null | undefined, max?: number): Range | null
/** The text a bookmark keeps for its range: the book's text, a space between blocks and `<br>` lines. */
export function bookmarkText(range: Range): string
export function startsWithin(visible: Range, range: Range): boolean
/** How many lines of text the rects lie on, along the block axis. */
export function lineCount(rects: Iterable<{ top: number; left: number; width: number; height: number }>, vertical?: boolean): number
export const TOP_LINES_ABOVE: number
/** The first rect with a size along the block axis (a range's first line). */
export function firstLine<R extends { width: number; height: number }>(rects: Iterable<R>, vertical?: boolean): R | undefined
/** `mark` is at the top of the screen whose first words are `place`. */
export function atTop(
  place: Range,
  mark: Range,
  opts?: { scrolled?: boolean; vertical?: boolean; rects?: (r: Range) => Iterable<{ top: number; left: number; width: number; height: number }>; placeLine?: () => { top: number; left: number; width: number; height: number } | undefined },
): boolean
/** #1350: a page bookmark's label: "<TOC title> · p. <page>", or "p. <page>". */
export function pageBookmarkText(title: string | null | undefined, page: string | number): string
/** #1350: the placed bookmark on section `index`, or null. */
export function pageBookmarkOn(highlights: { id: string; index?: number; color?: string }[], placed: Set<string>, index: number | null | undefined): string | null
/** One `bookmark-list` item, in book order; `text` is display only (cut). */
export type BookmarkItem = ListItem
export function bookmarkList(
  highlights: { id: string; cfi: string; color?: string; selectedText?: string; quote?: string; at?: number }[],
  placed: Set<string>,
  compare: (a: string, b: string) => number,
): BookmarkItem[]
/** `here`: the bookmark the place being read has (null: none); `can`: one can be made here now; `placing`: bookmarks are still being placed. */
export interface BookmarkList { key: string; bookmarks: BookmarkItem[]; here: string | null; can: boolean; placing: boolean }
/** Null for another book's than `open` (when given); a message without `bookmarks` (the list unchanged) keeps `prev`'s, null when `prev` is not that book's. */
export function readBookmarkList(m: unknown, opts?: { open?: string | null; prev?: BookmarkList | null }): BookmarkList | null
