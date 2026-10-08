import { resumeRoute, type ResumePick } from './bookRoutes'

export const resumePickKey = (pick: ResumePick) =>
  pick.type === 'edition' ? `edition:${pick.slug}` : `userbook:${pick.id}`

/** The busy flag every Continue on screen shares (hero + list), so two cannot push two readers. */
export type ResumeFlight = { busy: boolean }
export const createResumeFlight = (): ResumeFlight => ({ busy: false })
/** The app's one flight. Module-level on purpose: the hero and the list are separate components. */
export const appResumeFlight = createResumeFlight()

/**
 * Continue, when the place may have to be looked up first. While one lookup runs, every other
 * Continue is ignored (not queued), and no navigation happens once the screen has lost focus or
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
    if (flight.busy) return
    if (pick.chapterSlug) { o.push(resumeRoute(pick)); return }
    flight.busy = true
    o.onPending(resumePickKey(pick))
    try {
      const route = await o.resolve(pick)
      if (o.isActive()) o.push(route)
    } finally {
      flight.busy = false
      o.onPending(null)
    }
  }
}
