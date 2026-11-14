// Types for highlights.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
import type { V2Rect } from './selection.mjs'

export type V2HighlightColor = 'yellow' | 'green' | 'pink' | 'blue'
export const HIGHLIGHT_COLORS: readonly V2HighlightColor[]
export const HIGHLIGHT_FILL: Record<V2HighlightColor, string>
export function isHighlightColor(c: unknown): c is V2HighlightColor
export function colorOf(c: unknown): V2HighlightColor
export const MAX_LIST: number
export const MAX_LIST_TEXT: number
/** One `highlight-list` item: drawn on screen, in book order; `text` is display only (cut). */
export interface V2HighlightItem { id: string; cfi: string; color: V2HighlightColor; text: string; at: number | null }
export function highlightList(
  highlights: { id: string; cfi: string; color?: string; selectedText?: string; quote?: string; at?: number }[],
  drawn: Set<string>,
  compare: (a: string, b: string) => number,
): V2HighlightItem[]
export function readHighlightList(m: unknown): { key: string; highlights: V2HighlightItem[] } | null
/** A tap on a drawn highlight: its id, the highlight's box and where the tap landed (page-viewport px, `tap`'s space). */
export interface V2HighlightTap { id: string; rect: V2Rect; x: number; y: number }
export function readHighlightTap(m: unknown): V2HighlightTap | null
export function readHighlightRemoved(m: unknown): { key: string; id: string } | null
export function noteOf(text: unknown): string | null
/** The note a save writes; undefined when the draft is the note the editor opened with. */
export function noteChange(draft: unknown, shown: unknown): string | null | undefined
