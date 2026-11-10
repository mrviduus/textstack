/**
 * A V2 reader position by book fraction alone, `{ fraction, at }` (#1187): a server position in a
 * transitional `textstack-*` scheme, which nobody converts to a CFI. The one predicate for it: the
 * page (`store.mjs`, `page.mjs`), `statePosition`, `decideServerState` and the host all use this one.
 * No CFI, no quote, no page; the fraction a number in [0, 1].
 */
export interface FractionPosition {
  fraction: number
  at?: number
}

export function isFractionOnly(x: unknown): x is FractionPosition {
  const p = x as { fraction?: unknown; cfi?: unknown; quote?: unknown; page?: unknown } | null
  return typeof p?.fraction === 'number' && p.fraction >= 0 && p.fraction <= 1
    && p.cfi === undefined && p.quote === undefined && p.page === undefined
}
