// Types for store.mjs (apps/web type-checks it without allowJs: the V2 host's sync, #1226); a change to one must update the other.
import type { PageEntry, PageEntryBook, PageHighlight, PagePosition } from '../../../../../packages/shared/src/index'

export const STORE_VERSION: number
export function emptyEntry(book: PageEntryBook): PageEntry
export const quoteOf: (text: string) => string
export const isPosition: (x: unknown) => boolean
export function isPdfPage(x: unknown): x is { page: number }
/** The stored entry for this file, or null (missing, corrupt, another version, other bytes); only usable items kept. */
export function entryFor(json: string, book: { sha256: string; size: number | null }): PageEntry | null
export const withPosition: (e: PageEntry, p: unknown) => PageEntry
export const withHighlight: (e: PageEntry, h: unknown) => PageEntry
export const foldText: (text: string) => string
export function sha256(bytes: Uint8Array): string
export function sha256Yielding(bytes: Uint8Array, yieldNow?: () => Promise<unknown>): Promise<string>
export function sha1(str: string): Uint8Array
