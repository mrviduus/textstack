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
export interface SearchResult { cfi: string; pre: string; match: string; post: string; label: string }
export function searchItems(subitems: unknown): SearchResult[]
export interface SearchMessage { key: string; id: number; results: SearchResult[]; done: boolean; more: boolean; incomplete: boolean }
export function readSearchResults(m: unknown): SearchMessage | null
/**
 * A host's search: `query` '' is none; `done` false while the page still searches; `more`: a hit past `MAX_RESULTS`
 * exists; `incomplete`: part of the book could not be read; `searchable`: the open book can be searched.
 */
export interface Search { id: number; query: string; results: SearchResult[]; done: boolean; more: boolean; incomplete: boolean; searchable: boolean }
export const NO_SEARCH: Search
export function searchStart(s: Search, raw: unknown): Search
export function searchReset(s: Search): Search
export function searchOpened(s: Search, opened: unknown): Search
export function searchTake(s: Search, r: SearchMessage): Search
export type SearchStatus = '' | 'tooShort' | 'searching' | 'none' | 'count' | 'more'
export function searchStatusKeys(search: Search, typed: unknown): { status: SearchStatus; incomplete: boolean }
/** `(now)`: put the host's search on screen, at once (`now`) or within `SEARCH_RENDER_MS`. */
export function createSearchRenders(render: () => void, ms?: number): (now: boolean) => void
