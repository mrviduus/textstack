import { resumeRoute, type ResumePick } from './bookRoutes'

export const resumePickKey = (pick: ResumePick) =>
  pick.type === 'edition' ? `edition:${pick.slug}` : `userbook:${pick.id}`

/** The busy flag every Continue on screen shares (hero + list), so two cannot push two readers. */
export type ResumeFlight = { owner: number | null; since: number; now: () => number }
export const createResumeFlight = (now: () => number = Date.now): ResumeFlight => ({ owner: null, since: 0, now })
/** The app's one flight. Module-level on purpose: the hero and the list are separate components. */
export const appResumeFlight = createResumeFlight()
/** A lookup older than this no longer blocks Continue (a hung request must not lock the shelf). */
const FLIGHT_TIMEOUT_MS = 8000
/** Free the flag — the screen lost focus, so whatever was in flight will not navigate anyway. */
export const releaseResumeFlight = (flight: ResumeFlight = appResumeFlight) => { flight.owner = null }
const isBusy = (f: ResumeFlight) => f.owner !== null && f.now() - f.since < FLIGHT_TIMEOUT_MS
let nextOwner = 1

/**
 * Continue, when the place may have to be looked up first. While one lookup runs (up to 8s), every
 * other Continue is ignored (not queued), and no navigation happens once the screen has lost focus or
 * unmounted — a late answer must not yank the reader somewhere they already left. `onPending`
 * drives the spinner.
 */
export function createResumeOpener(o: {
  resolve: (pick: ResumePick) => Promise<string>
  push: (route: string) => void
  isActive: () => boolean
  onPending: (key: string | null) => void
  flight?: ResumeFlight
}) {
  const flight = o.flight ?? appResumeFlight
  return async (pick: ResumePick): Promise<void> => {
    if (isBusy(flight)) return
    if (pick.chapterSlug) { o.push(resumeRoute(pick)); return }
    const me = nextOwner++
    flight.owner = me
    flight.since = flight.now()
    o.onPending(resumePickKey(pick))
    try {
      const route = await o.resolve(pick)
      // Still ours (not expired and taken over, not released by a blur) and still on screen.
      if (flight.owner === me && o.isActive()) o.push(route)
    } finally {
      if (flight.owner === me) flight.owner = null
      o.onPending(null)
    }
  }
}
