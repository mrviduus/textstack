// Types for chrome.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown' | 'Space' | 'Escape'
export const NAV_KEYS: readonly NavKey[]
export function navKey(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean; target?: unknown }):
  { type: 'key'; key: NavKey; shift: boolean; repeat: boolean } | null
/** Where a tap landed, in page-viewport px (the space of `word.rect`). */
export function readTap(m: unknown): { x: number; y: number } | null
/** The direction the book pages in, from `opened` or `relocate`; null when absent or malformed (left to right). */
export function readDir(m: unknown): 'ltr' | 'rtl' | null
/** `repeat`: the key is held (auto-repeat); hosts turn once per press. */
export function readKey(m: unknown): { key: NavKey; shift: boolean; repeat: boolean } | null
export type KeyAction = 'prev' | 'next' | 'bars'
export function keyAction(k: { key: NavKey; shift: boolean; dir: 'ltr' | 'rtl' }): KeyAction | null
/** The page's `relocate.cause` (#1313). */
export type Cause = 'turn' | 'nav' | 'layout'
export function readRelocate(m: unknown): { fraction: number | null; index: number | null; sections: number | null; toc: string; tocIndex: number | null; dir: 'ltr' | 'rtl' | null; moved: boolean; cause: Cause; atEnd: boolean; sectionEnd: number | null; words: number | null } | null
export const HOST_MOVE_GRACE_MS: number
export function hidesBarsOnRelocate(input: { moved: boolean; msSinceHostMove: number }): boolean
export function createHostMoves(): { start(): void; onRelocate(now: number): number }
export const BOOK_CLOSED: 'book-closed'
export const CLOSE_BOOK_JS: string
export function reopensOnReady(input: { opening: unknown; inBook: boolean }): boolean
export function takenWithoutBook(type: unknown): boolean
export function readLightbox(m: unknown): boolean | null
export function backAction(input: { offer: boolean; lightbox?: boolean; ready?: boolean; popup?: boolean; reading: boolean }): 'close-offer' | 'close-lightbox' | 'close-popup' | 'close-book' | 'leave'
