// Types for settings.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export type V2FontFamily = 'serif' | 'sans' | 'dyslexic'
export type V2TextAlign = 'left' | 'center' | 'justify'
export type V2Theme = 'light' | 'sepia' | 'dark'
export interface V2Settings { fontSize: number; lineHeight: number; fontFamily: V2FontFamily; textAlign: V2TextAlign; theme: V2Theme }
export const FONT_MIN: number
export const FONT_MAX: number
export const FONT_STEP: number
export const LINE_HEIGHTS: readonly number[]
export const FAMILIES: readonly V2FontFamily[]
export const ALIGNS: readonly V2TextAlign[]
export const THEMES: Readonly<Record<V2Theme, { bg: string; fg: string }>>
export const DEFAULTS: Readonly<V2Settings>
export const SETTINGS_KEY: string
/** The valid choices in `raw`, nothing else. */
export function readChosen(raw: unknown): Partial<V2Settings>
/** Whole, valid settings from anything. */
export function readSettings(raw: unknown): V2Settings
/** A stored value (JSON, or null) as choices; malformed is none. */
export function parseChosen(json: string | null | undefined): Partial<V2Settings>
export function choose(chosen: Partial<V2Settings>, patch: Partial<V2Settings>): Partial<V2Settings>
export function settingsCss(raw: unknown, fontUrl?: string | null): string
