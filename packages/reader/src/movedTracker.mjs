// The open book as ADR-019 sees it (#1278): `decideServerState`'s `reader`, one rule for every host. Pure.
//
// "Moved" is the page's own word (`relocate.moved`, README Protocol: not a re-layout, not the same place again,
// not the host moving the view), never a host's comparison of CFIs: a book with no stored place gets no relocate
// from its restore to compare against. The spine index is the last relocate's, the opening one included (the
// page shows the start before `opened`), so a reader who has not turned a page yet has one too.
export function createMovedTracker() {
  let restored = false
  let moved = false
  let index = null
  return {
    /** A new open (or the book closed): nothing restored, no place. */
    open() {
      restored = false
      moved = false
      index = null
    },
    /** `restored` for the open book (openTracker.mjs `restored`): what came before is not the reader's. */
    restored() {
      restored = true
      moved = false
    },
    /** A `relocate` as `readRelocate` (chrome.mjs) returns it; null is dropped. */
    relocate(r) {
      if (!r) return
      index = r.index
      if (r.moved) moved = true
    },
    /** The host sent a `goTo`: the place it lands on is where the reader was put, not where they moved to. */
    hostMove() {
      moved = false
    },
    reader() {
      return { restoreApplied: restored, moved, index }
    },
  }
}
