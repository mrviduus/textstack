// What a page `tap` does in the host (#1263): pure, both hosts. Only a `tap` comes here: a word answers `word`,
// a link `openLink` (or nothing, foliate follows it), a selection nothing, so none of them can turn a page.

/** The share of the width each edge takes: a tap there turns the page (paginated flow only). */
export const EDGE_SHARE = 0.25

/**
 * 'prev' / 'next' for a tap on an edge in paginated flow, else 'toggle' (the bars). `x`: the tap in the page's
 * viewport, `width`: that viewport's width. A tap without `x` (the page sends no coordinates yet) or in scrolled
 * flow toggles. `dir` 'rtl' (a right-to-left book) turns the edges round: its left edge is the next page.
 */
export function tapAction({ x, width, flow, dir }) {
  if (flow !== 'paginated' || !Number.isFinite(x) || !(width > 0)) return 'toggle'
  const left = x < width * EDGE_SHARE
  if (!left && x <= width * (1 - EDGE_SHARE)) return 'toggle'
  return left === (dir === 'rtl') ? 'next' : 'prev'
}
