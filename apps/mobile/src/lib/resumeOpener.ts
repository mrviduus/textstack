import { resumeRoute, type ResumePick } from './bookRoutes'

export const resumePickKey = (pick: ResumePick) =>
  pick.type === 'edition' ? `edition:${pick.slug}` : `userbook:${pick.id}`

/**
 * Continue, when the place has to be looked up first. One lookup at a time (repeat taps are
 * ignored, not queued), and no navigation once the screen has lost focus or unmounted — a late
 * answer must not yank the reader somewhere they already left. `onPending` drives the spinner.
 */
export function createResumeOpener(o: {
  resolve: (pick: ResumePick) => Promise<string>
  push: (route: string) => void
  isActive: () => boolean
  onPending: (key: string | null) => void
}) {
  let inFlight = false
  return async (pick: ResumePick): Promise<void> => {
    if (inFlight) return
    if (pick.chapterSlug) { o.push(resumeRoute(pick)); return }
    inFlight = true
    o.onPending(resumePickKey(pick))
    try {
      const route = await o.resolve(pick)
      if (o.isActive()) o.push(route)
    } finally {
      inFlight = false
      o.onPending(null)
    }
  }
}
