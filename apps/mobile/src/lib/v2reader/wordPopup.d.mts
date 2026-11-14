// Types for wordPopup.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
import type { V2Rect, V2Selection } from './selection.mjs'
import type { TapAction } from './tapZone.mjs'

export const MAX_WORD: number
/** A tapped word as a host takes it: `rect` in page-viewport px; `cfi` null where nothing can be drawn (a PDF). */
export interface V2Word { index: number; word: string; sentence: string; cfi: string | null; rect: V2Rect }
export function readWord(m: unknown): V2Word | null
export function readLang(m: unknown): string | null
export type V2Popup = ({ kind: 'word' } & V2Word) | ({ kind: 'selection' } & V2Selection)
export type V2PopupEvent =
  | { type: 'word'; word: V2Word }
  | { type: 'tap'; x: number }
  | { type: 'selection'; selection: V2Selection }
  | { type: 'selection-cleared' }
  | { type: 'moved' }
export function popupStep(
  popup: V2Popup | null,
  e: V2PopupEvent,
  zone: { width?: number; flow: 'paginated' | 'scrolled'; dir?: 'ltr' | 'rtl' },
): { popup: V2Popup | null; turn: TapAction | null }
