// Types for selection.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SELECTION_MAX_CHARS: number
export const MAX_SELECTION_TEXT: number
export const MAX_SELECTION_SENTENCE: number
export const MAX_SELECTION_CFI: number
interface Box { left: number; top: number; width: number; height: number }
export interface V2Selection {
  index: number
  text: string
  /** null where nothing can be drawn at one (a PDF), or past MAX_SELECTION_CFI. */
  cfi: string | null
  sentence: string
  /** Over the server's translate/TTS cap (500); text over MAX_SELECTION_TEXT is cut there. */
  tooLong: boolean
  /** Page-viewport coordinates of the selection's bounding box. */
  rect: { x: number; y: number; w: number; h: number }
}
export function selectionMessage(s: { index: number; text: string; cfi: string | null; sentence: string; frame: Box; range: Box }): ({ type: 'selection' } & V2Selection) | null
export function readSelection(m: unknown): V2Selection | null
