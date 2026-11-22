// Types for wordPopup.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
import type { Rect, PageSelection } from './selection.mjs'
import type { TapAction } from './tapZone.mjs'
import type { HighlightTap } from './highlights.mjs'

export const MAX_WORD: number
/** A tapped word as a host takes it: `rect` in page-viewport px; `cfi` null where nothing can be drawn (a PDF). */
export interface PageWord { index: number; word: string; sentence: string; cfi: string | null; rect: Rect }
export function readWord(m: unknown): PageWord | null
export function readLang(m: unknown): string | null
export type Popup = ({ kind: 'word' } & PageWord) | ({ kind: 'selection' } & PageSelection) | ({ kind: 'highlight' } & HighlightTap)
export type PopupEvent =
  | { type: 'word'; word: PageWord }
  | { type: 'tap'; x: number }
  | { type: 'selection'; selection: PageSelection }
  | { type: 'selection-cleared' }
  | { type: 'moved' }
  | { type: 'highlight'; highlight: HighlightTap }
export function popupStep(
  popup: Popup | null,
  e: PopupEvent,
  zone: { width?: number; flow: 'paginated' | 'scrolled'; dir?: 'ltr' | 'rtl' },
): { popup: Popup | null; turn: TapAction | null }
