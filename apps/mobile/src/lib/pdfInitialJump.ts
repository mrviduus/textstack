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
  /** This chapter owns the front matter (pages before its start). */
  firstChapter?: boolean
  resumePage: number | null | undefined
  pageCount?: number | null
}): InitialPdfJump {
  if (!o.resumeReady) return { kind: 'wait' }
  const page = resolvePdfResumePage(o)
  // Where the bootstrap opened: the chapter's start page, else page 1. A target BELOW the start
  // (front matter) must jump too — `page > 1` used to leave the reader on the start, which was saved.
  const s = o.chapterStartPage
  const opened = typeof s === 'number' && Number.isFinite(s) && s >= 1 ? Math.floor(s) : 1
  return page !== opened ? { kind: 'jump', page } : { kind: 'stay', page }
}
