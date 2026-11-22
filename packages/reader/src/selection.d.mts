// Types for selection.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SELECTION_MAX_CHARS: number
export const MAX_SELECTION_SENTENCE: number
export const MAX_SELECTION_CFI: number
export function isCfi(c: unknown): c is string
export const MAX_SELECTION_INDEX: number
export const MAX_SELECTION_PX: number
export interface Rect { x: number; y: number; w: number; h: number }
/**
 * The `selection` message as the page sends it. It supersedes a `word`: a double-click sends `word` then
 * `selection`, and the host closes a word popup when a selection arrives.
 */
export interface SelectionMessage {
  type: 'selection'
  index: number
  text: string
  /** null where nothing can be drawn at one (a PDF), when the text was cut, or past MAX_SELECTION_CFI. */
  cfi: string | null
  sentence: string
  /** Page-viewport coordinates of the selection's bounding box. */
  rect: Rect
}
/** What a host takes: the message's fields and `tooLong` (over the translate/TTS cap), derived by the host. */
export interface PageSelection extends Omit<SelectionMessage, 'type'> { tooLong: boolean }
export function selectionMessage(s: { index: number; text: string; cfi: string | null; sentence: string; rect: Rect }): SelectionMessage | null
export function readSelection(m: unknown): PageSelection | null
export function readRect(rect: unknown): Rect | null
