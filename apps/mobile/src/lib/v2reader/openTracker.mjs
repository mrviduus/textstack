// What a host makes of the page's open answers (S5 review), one rule for both hosts (V2ReaderScreen,
// web V2ReaderDevPage). Pure. Each open is known by the `name` the host passed to `openUrl`, which the page
// echoes in `opened.book.name` / `open-failed.name`.
//
// The page answers `opened` for the book on screen even while a newer open is under way (that one may
// still fail before its swap). Such an answer is kept aside (`standby`): taken if the newer open fails,
// dropped if it opens. `restored` carries its book's key; one for a book that is not the one taken is
// dropped (a stale answer must not mark the new book restored).
//
// After a failed open with no book taken, the page keeps the old book reading (README, Formats) and it may
// still relocate; the host has already cleared its position and holds no open. `showsPosition()` is false
// then, until the next open or take, so neither host puts a position back (#1168; seen in the web e2e).
// The cost, by choice: turning pages in that still-visible old book shows no position until the next pick.
export function createOpenTracker() {
  let current = null
  let standby = null
  let shownKey = null
  let showing = true
  const pending = new Map()
  /** The page's book is `open`'s now: every other open still pending is over (the host drops their files). */
  const take = (open, opened) => {
    const dropped = [...pending.values()].filter((o) => o !== open)
    pending.clear()
    current = null
    standby = null
    shownKey = opened.book?.sha256 ?? null
    showing = true
    return { open, opened, dropped }
  }
  return {
    /** An `openUrl(…, name)` the host sent. */
    open(name, open) {
      current = open
      pending.set(name, open)
      showing = true
    },
    /** `opened`: the take (`{ open, opened, dropped }`) to act on, or null (kept aside, or not ours). */
    opened(m) {
      const open = pending.get(m.book?.name)
      if (!open) return null
      if (open === current || !current) return take(open, m)
      standby = { open, opened: m }
      return null
    },
    /** `open-failed`: `{ failed, take }` (`take` the book kept on screen, if one answered), or null if not the open in flight. */
    failed(name) {
      const failed = pending.get(name)
      if (!failed || failed !== current) return null
      pending.delete(name)
      current = null
      const kept = standby
      showing = false
      return { failed, take: kept ? take(kept.open, kept.opened) : null }
    },
    /** `restored`: true only for the book taken last. */
    restored(m) {
      return shownKey !== null && m.key === shownKey
    },
    /** `relocate`: whether to show its position (false after a failed open, until the next open or take). */
    showsPosition() {
      return showing
    },
  }
}
