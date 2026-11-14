// Types for selection.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SELECTION_MAX_CHARS: number
export const MAX_SELECTION_SENTENCE: number
export const MAX_SELECTION_CFI: number
export const MAX_SELECTION_INDEX: number
export const MAX_SELECTION_PX: number
export interface V2Rect { x: number; y: number; w: number; h: number }
/**
 * The `selection` message as the page sends it. It supersedes a `word`: a double-click sends `word` then
 * `selection`, and the host closes a word popup when a selection arrives.
 */
export interface V2SelectionMessage {
  type: 'selection'
  index: number
  text: string
  /** null where nothing can be drawn at one (a PDF), when the text was cut, or past MAX_SELECTION_CFI. */
  cfi: string | null
  sentence: string
  /** Page-viewport coordinates of the selection's bounding box. */
  rect: V2Rect
}
/** What a host takes: the message's fields and `tooLong` (over the translate/TTS cap), derived by the host. */
export interface V2Selection extends Omit<V2SelectionMessage, 'type'> { tooLong: boolean }
export function selectionMessage(s: { index: number; text: string; cfi: string | null; sentence: string; rect: V2Rect }): V2SelectionMessage | null
export function readSelection(m: unknown): V2Selection | null
export function readRect(rect: unknown): V2Rect | null
