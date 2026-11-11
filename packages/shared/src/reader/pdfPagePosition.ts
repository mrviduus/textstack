/**
 * A V2 reader position on a PDF (#1128 S5): `{ page, index, fraction, at }`, `page` the 1-based page
 * number (the `pdf-page` locator, ADR-031; foliate's section index + 1). No CFI and no quote: a PDF
 * position is never an `epub-cfi` one. The one predicate for it: the page (`store.mjs`, `page.mjs`)
 * and `positionWrite` / `statePosition` all use this one.
 */
export interface PdfPagePosition {
  page: number
  index?: number
  fraction?: number
  at?: number
}

export function isPdfPage(x: unknown): x is PdfPagePosition {
  const p = x as { page?: unknown; cfi?: unknown; quote?: unknown } | null
  return Number.isInteger(p?.page) && (p!.page as number) >= 1 && p!.cfi === undefined && p!.quote === undefined
}
