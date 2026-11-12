// Types for chrome.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export type V2NavKey = 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown' | 'Space' | 'Escape'
export const NAV_KEYS: readonly V2NavKey[]
export function navKey(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean; target?: unknown }):
  { type: 'key'; key: V2NavKey; shift: boolean; repeat: boolean } | null
/** Where a tap landed, in page-viewport px (the space of `word.rect`). */
export function readTap(m: unknown): { x: number; y: number } | null
/** The direction the book pages in, from `opened` or `relocate`; null when absent or malformed (left to right). */
export function readDir(m: unknown): 'ltr' | 'rtl' | null
/** `repeat`: the key is held (auto-repeat); hosts turn once per press. */
export function readKey(m: unknown): { key: V2NavKey; shift: boolean; repeat: boolean } | null
export type V2KeyAction = 'prev' | 'next' | 'bars'
export function keyAction(k: { key: V2NavKey; shift: boolean; dir: 'ltr' | 'rtl' }): V2KeyAction | null
export function readRelocate(m: unknown): { fraction: number | null; index: number | null; sections: number | null; toc: string; dir: 'ltr' | 'rtl' | null } | null
export const HOST_MOVE_GRACE_MS: number
export function hidesBarsOnRelocate(input: { flow: 'paginated' | 'scrolled' | null; moved: boolean; msSinceHostMove: number }): boolean
export function createHostMoves(): { start(): void; onRelocate(now: number): number }
export const BOOK_CLOSED: 'book-closed'
export const CLOSE_BOOK_JS: string
export function reopensOnReady(input: { opening: unknown; inBook: boolean }): boolean
export function takenWithoutBook(type: unknown): boolean
export function backAction(input: { offer: boolean; reading: boolean }): 'close-offer' | 'close-book' | 'leave'
