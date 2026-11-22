// Types for toc.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
/** `index`: the entry's place in the page's `opened.toc`, what `relocate.tocIndex` names. */
export interface TocEntry { index: number; label: string; href: string; depth: number }
export const MAX_TOC_ENTRIES: number
export const MAX_TOC_DEPTH: number
export function readToc(m: unknown): TocEntry[]
export function tocAround(toc: readonly TocEntry[], tocIndex: number | null):
  { prev: TocEntry | null; current: TocEntry | null; next: TocEntry | null }
export function withTitle(text: string, title: string): string
