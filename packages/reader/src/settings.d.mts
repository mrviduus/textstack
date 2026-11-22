// Types for settings.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export type FontFamily = 'serif' | 'sans' | 'dyslexic'
export type TextAlign = 'book' | 'left' | 'center' | 'justify'
export type Theme = 'light' | 'sepia' | 'dark'
export interface Settings { fontSize: number; lineHeight: number; fontFamily: FontFamily; textAlign: TextAlign; theme: Theme }
export const FONT_MIN: number
export const FONT_MAX: number
export const FONT_STEP: number
export const LINE_HEIGHTS: readonly number[]
export const FAMILIES: readonly FontFamily[]
export const ALIGNS: readonly TextAlign[]
export const THEMES: Readonly<Record<Theme, { bg: string; fg: string }>>
export const DEFAULTS: Readonly<Settings>
export const SETTINGS_KEY: string
/** The valid choices in `raw`, nothing else. */
export function readChosen(raw: unknown): Partial<Settings>
/** Whole, valid settings from anything. */
export function readSettings(raw: unknown): Settings
/** A stored value (JSON, or null) as choices; malformed is none. */
export function parseChosen(json: string | null | undefined): Partial<Settings>
export function choose(chosen: Partial<Settings>, patch: Partial<Settings>): Partial<Settings>
export interface FontUrls { regular?: string; bold?: string; italic?: string; boldItalic?: string }
export function settingsCss(raw: unknown, fontUrl?: string | FontUrls | null): string
export function fontFamilyCss(raw: unknown): string
