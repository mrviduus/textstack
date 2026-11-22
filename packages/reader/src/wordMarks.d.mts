// Types for wordMarks.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
/** One saved word as the page draws it: its SRS stage (0–4) and its translation, or null. */
export interface MarkWord { word: string; stage: number; gloss: string | null }
export const MAX_WORDS: number
export const MAX_WORD: number
export const MAX_GLOSS: number
export const STAGE_COLORS: readonly string[]
export function stageOf(s: unknown): number
export function readMarkWords(raw: unknown): MarkWord[]
export function wordMarksIn(root: Node | null | undefined, words: MarkWord[]): { range: Range; word: MarkWord }[]
export const GLOSS_SETTING: 'showInlineTranslations'
export function readGlosses(json: string | null): boolean
export function withGlosses(json: string | null, on: boolean): string
export function sameMark(a: { stage: number; gloss: string | null } | undefined, b: { stage: number; gloss: string | null } | undefined): boolean
