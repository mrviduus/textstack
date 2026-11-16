// Types for search.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SEARCH_DEBOUNCE_MS: number
export const SEARCH_RENDER_MS: number
export const MIN_QUERY: number
export const MAX_QUERY: number
export const MAX_RESULTS: number
export const MAX_CONTEXT: number
export const MAX_MATCH: number
export const MAX_LABEL: number
export const SEARCH_FILL: string
export function queryLength(t: string): number
export function readQuery(q: unknown): string | null
/** One hit: where it is (a CFI `goTo` takes), the hit as the book writes it, the text around it, the contents entry it is under ('': none). */
export interface V2SearchResult { cfi: string; pre: string; match: string; post: string; label: string }
export function searchItems(subitems: unknown): V2SearchResult[]
export interface V2SearchMessage { key: string; id: number; results: V2SearchResult[]; done: boolean; more: boolean; incomplete: boolean }
export function readSearchResults(m: unknown): V2SearchMessage | null
/**
 * A host's search: `query` '' is none; `done` false while the page still searches; `more`: a hit past `MAX_RESULTS`
 * exists; `incomplete`: part of the book could not be read; `searchable`: the open book can be searched.
 */
export interface V2Search { id: number; query: string; results: V2SearchResult[]; done: boolean; more: boolean; incomplete: boolean; searchable: boolean }
export const NO_SEARCH: V2Search
export function searchStart(s: V2Search, raw: unknown): V2Search
export function searchReset(s: V2Search): V2Search
export function searchOpened(s: V2Search, opened: unknown): V2Search
export function searchTake(s: V2Search, r: V2SearchMessage): V2Search
export type V2SearchStatus = '' | 'tooShort' | 'searching' | 'none' | 'count' | 'more'
export function searchStatusKeys(search: V2Search, typed: unknown): { status: V2SearchStatus; incomplete: boolean }
/** `(now)`: put the host's search on screen, at once (`now`) or within `SEARCH_RENDER_MS`. */
export function createSearchRenders(render: () => void, ms?: number): (now: boolean) => void
