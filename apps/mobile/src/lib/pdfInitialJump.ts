import { resolvePdfResumePage } from '@textstack/shared'

/**
 * The Original PDF's first move once the viewer is ready. The bootstrap already opened it at the
 * chapter's start page (or page 1), so this only says whether to move from there.
 *
 * Always waits for the DEVICE's page (`resumeReady`) — a read of the local record, never the
 * network. A known start page used to skip that wait and drop the device page (R4 bug 2), though
 * `resolvePdfResumePage` keeps a page inside the chapter for exactly this case.
 */
export type InitialPdfJump = { kind: 'wait' } | { kind: 'jump'; page: number } | { kind: 'stay'; page: number }

export function initialPdfJump(o: {
  resumeReady: boolean
  chapterStartPage: number | null | undefined
  chapterEndPage: number | null
  resumePage: number | null | undefined
}): InitialPdfJump {
  if (!o.resumeReady) return { kind: 'wait' }
  const page = resolvePdfResumePage(o)
  return page > 1 && page !== o.chapterStartPage ? { kind: 'jump', page } : { kind: 'stay', page }
}
