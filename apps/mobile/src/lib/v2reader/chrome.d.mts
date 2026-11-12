// Types for chrome.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export type V2NavKey = 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown' | 'Space' | 'Escape'
export const NAV_KEYS: readonly V2NavKey[]
export function navKey(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: unknown }):
  { type: 'key'; key: V2NavKey; shift: boolean } | null
/** Where a tap landed, in page-viewport px (the space of `word.rect`). */
export function readTap(m: unknown): { x: number; y: number } | null
/** The book's reading direction from `opened`; null when absent or malformed (left to right). */
export function readDir(m: unknown): 'ltr' | 'rtl' | null
export function readKey(m: unknown): { key: V2NavKey; shift: boolean } | null
