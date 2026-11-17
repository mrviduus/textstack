// When may a downloaded update replace the running app?
//
// `reloadAsync` restarts the JS. That is cheap in the abstract and expensive at
// the wrong moment: this app's whole premise is uninterrupted long-form reading,
// and a restart mid-chapter is the one interruption it cannot justify to itself.
//
// So the update lands as soon as it is ready, except where landing would take
// something away — and then it waits, because the next check will offer it again.

/** Routes where a restart would interrupt reading rather than refresh a screen. */
const READING_ROUTES = ['/my-books/read']

export type ApplyInput = {
  /** An update is downloaded and will be used on the next launch. */
  isUpdatePending: boolean
  /** Metro-served build: there is nothing to apply and reloading loses the session. */
  isDev: boolean
  /** Current route, from the router. */
  pathname: string
}

export function shouldApplyUpdate(s: ApplyInput): boolean {
  if (s.isDev) return false
  if (!s.isUpdatePending) return false
  return !isReading(s.pathname)
}

export function isReading(pathname: string): boolean {
  // Prefix match rather than equality: reader routes carry a book slug and a
  // chapter, so the path is always longer than the segment being matched.
  return READING_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'))
}
