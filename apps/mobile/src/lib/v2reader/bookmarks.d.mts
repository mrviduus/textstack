// Types for bookmarks.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
/** The `color` that makes an entry highlight (and a V2 annotation) a bookmark. */
export const BOOKMARK: 'bookmark'
export function isBookmark(h: { color?: string | null } | null | undefined): boolean
export const BOOKMARK_TEXT: number
export function bookmarkRange(visible: Range | null | undefined, max?: number): Range | null
/** The text a bookmark keeps for its range: a space between blocks, otherwise the range's own text. */
export function bookmarkText(range: Range): string
export function startsWithin(visible: Range, range: Range): boolean
/** One `bookmark-list` item, in book order; `text` is display only (cut). */
export interface V2BookmarkItem { id: string; cfi: string; text: string; at: number | null }
export function bookmarkList(
  highlights: { id: string; cfi: string; color?: string; selectedText?: string; quote?: string; at?: number }[],
  placed: Set<string>,
  compare: (a: string, b: string) => number,
): V2BookmarkItem[]
/** `here`: the bookmark on screen (null: none); `can`: one can be made here. */
export interface V2BookmarkList { key: string; bookmarks: V2BookmarkItem[]; here: string | null; can: boolean }
export function readBookmarkList(m: unknown): V2BookmarkList | null
