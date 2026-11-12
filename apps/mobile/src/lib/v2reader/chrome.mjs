// The reader chrome's decisions (pure, both hosts, #1263/#1264): what a tap does, when scrolling hides the
// bars, what Android back closes. The page reports a tap that is not on a word or a link as `tap`; a word is
// `word`, a link `openLink`, and a tap while a selection is up reports nothing (page.mjs onTap).

/** Share of the width each edge zone takes; the middle toggles the bars. */
export const EDGE = 0.25
/** A press held this long may have started a selection: the next tap dismisses it. */
export const LONG_PRESS_MS = 500
/** A touch pairs with the page's `tap` only within this window. */
export const PAIR_MS = 1000
/** A relocate this soon after a bar control was pressed (the bar's own prev/next) keeps the bars up. */
export const BAR_PRESS_GRACE_MS = 1000

/**
 * What a tap does: 'prev' | 'next' | 'toggle' | 'none'. `kind` is the page's message type: only a `tap`
 * acts (a word or a link never turns the page). `selection`: this tap dismissed a selection, so nothing
 * happens. `x` (host viewport) null: where it landed is unknown, so it only toggles. Scrolled flow has no
 * zones. `rtl`: the book's pages progress right to left, so the left edge is next.
 */
export function tapAction({ kind, x, width, flow, selection = false, rtl = false }) {
  if (kind !== 'tap' || selection) return 'none'
  if (flow !== 'paginated' || x == null || !(width > 0)) return 'toggle'
  const side = x < width * EDGE ? 'left' : x > width * (1 - EDGE) ? 'right' : null
  if (!side) return 'toggle'
  return (side === 'right') !== rtl ? 'next' : 'prev'
}

/**
 * Pairs the host's touches with the page's `tap` (the page's `tap` carries no coordinates) and tells a
 * tap that dismissed a selection (the page does not report selections). `at` in ms.
 * ponytail: a long press stands in for "a selection is up"; a long press that selected nothing costs the
 * next tap its action. Drop once the page's `tap` carries x and whether it dismissed a selection.
 */
export function createTouchTracker() {
  let down = null
  let last = null
  let selecting = false
  return {
    start(x, at) { down = { x, at } },
    end(x, at) {
      if (down && at - down.at >= LONG_PRESS_MS) selecting = true
      last = { x, at }
      down = null
    },
    /** For each `tap` or `word`: where the tap was (null: no touch close enough) and whether it dismissed a selection. */
    take(at) {
      const r = { x: last && at - last.at <= PAIR_MS ? last.x : null, selection: selecting }
      last = null
      selecting = false
      return r
    },
  }
}

/** Scrolling (the reader moving, scrolled flow) hides the bars, unless a bar control just moved it. */
export function hidesBarsOnRelocate({ flow, moved, msSinceBarPress }) {
  return flow === 'scrolled' && moved && !(msSinceBarPress < BAR_PRESS_GRACE_MS)
}

/** Android back, in order: the offer, then the open book (back to the list), then the route. */
export function backAction({ offer, reading }) {
  if (offer) return 'close-offer'
  if (reading) return 'close-book'
  return 'leave'
}
