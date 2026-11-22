// Types for highlights.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
import type { Rect } from './selection.mjs'

export type HighlightColor = 'yellow' | 'green' | 'pink' | 'blue'
export const HIGHLIGHT_COLORS: readonly HighlightColor[]
export const HIGHLIGHT_FILL: Record<HighlightColor, string>
export function isHighlightColor(c: unknown): c is HighlightColor
export function colorOf(c: unknown): HighlightColor
export const MAX_LIST: number
export const MAX_LIST_TEXT: number
/**
 * One `highlight-list` item: drawn on screen, in book order; `text` is display only (cut). A `quotation` (#1195, a legacy
 * anchor annotation) is listed after them, never drawn: its `cfi` is '' and it goes nowhere.
 */
export interface HighlightItem { id: string; cfi: string; color: HighlightColor; text: string; at: number | null; quotation?: true }
export function highlightList(
  highlights: { id: string; cfi: string; color?: string; selectedText?: string; quote?: string; at?: number }[],
  drawn: Set<string>,
  compare: (a: string, b: string) => number,
  quotes?: { id: string; selectedText: string; color?: string; at?: number }[],
): HighlightItem[]
/** One list item without its colour (a bookmark's, #1314). */
export interface ListItem { id: string; cfi: string; text: string; at: number | null }
type Listed = { id: string; cfi: string; color?: string; selectedText?: string; quote?: string; at?: number }
export function listItems(highlights: Listed[], ids: Set<string>, compare: (a: string, b: string) => number, color?: false): ListItem[]
export function listItems(highlights: Listed[], ids: Set<string>, compare: (a: string, b: string) => number, color: true): HighlightItem[]
export function readItems(list: unknown[], color?: false): ListItem[]
export function readItems(list: unknown[], color: true): HighlightItem[]
export function sameRangeHighlight<H extends { id: string; cfi: string }>(highlights: H[], cfi: string, drawn: Set<string>): H | undefined
export function readHighlightList(m: unknown): { key: string; highlights: HighlightItem[] } | null
/** A tap on a drawn highlight: its id, the highlight's box and where the tap landed (page-viewport px, `tap`'s space). */
export interface HighlightTap { id: string; rect: Rect; x: number; y: number }
export function readHighlightTap(m: unknown): HighlightTap | null
/** A highlight id as the page holds it: a v4 or the server's UUID, or a pre-#1078 `h…` one. */
export function isId(id: unknown): id is string
export function readHighlightRemoved(m: unknown): { key: string; id: string } | null
export function noteOf(text: unknown): string | null
/** The note a save writes; undefined when the draft is the note the editor opened with. */
export function noteChange(draft: unknown, shown: unknown): string | null | undefined
