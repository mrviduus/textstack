// Types for search.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const MIN_QUERY: number
export const MAX_QUERY: number
export const MAX_RESULTS: number
export const MAX_CONTEXT: number
export const MAX_MATCH: number
export const MAX_LABEL: number
export const SEARCH_FILL: string
export function readQuery(q: unknown): string | null
/** One hit: where it is (a CFI `goTo` takes), the hit as the book writes it, the text around it, its section's title ('': none). */
export interface V2SearchResult { cfi: string; pre: string; match: string; post: string; label: string }
export function searchItems(subitems: unknown, label: unknown): V2SearchResult[]
export interface V2SearchMessage { key: string; id: number; results: V2SearchResult[]; done: boolean; more: boolean }
export function readSearchResults(m: unknown): V2SearchMessage | null
/** A host's search: `query` '' is none; `done` false while the page still searches; `more`: stopped at `MAX_RESULTS`. */
export interface V2Search { id: number; query: string; results: V2SearchResult[]; done: boolean; more: boolean }
export const NO_SEARCH: V2Search
export function searchStart(s: V2Search, raw: unknown): V2Search
export function searchTake(s: V2Search, r: V2SearchMessage): V2Search
