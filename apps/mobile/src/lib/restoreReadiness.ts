/**
 * When the reader's scroll-restore may fire: the WebView has loaded THIS document and the saved
 * position for it has been read. Whichever lands last fires it, once.
 *
 * The load effect in `useReaderPersistence` re-runs for two different reasons, and they must not be
 * treated alike. A new document (another chapter, or a PDF viewer swapped for the reflow one) will
 * send its own `onLoadEnd`, so "loaded" resets. The book id resolving (null → id, catalog) only
 * re-reads the position: the document on screen is the same and will NOT load again. Resetting
 * "loaded" there (C1) meant restore never ran and the write gate stayed shut for the whole visit
 * whenever the WebView beat `getBook`.
 */
export interface Readiness {
  /** The document the state belongs to — `${enabled}:${chapterSlug}` in the hook. */
  doc: string | null
  webViewLoaded: boolean
  positionLoaded: boolean
  restored: boolean
}

export type ReadinessEvent =
  /** The load effect ran for `doc`: about to (re-)read its saved position. */
  | { type: 'opened'; doc: string }
  | { type: 'webViewLoaded' }
  | { type: 'positionLoaded' }
  | { type: 'restoreFired' }

export const READINESS_INITIAL: Readiness = { doc: null, webViewLoaded: false, positionLoaded: false, restored: false }

export function readinessReduce(s: Readiness, e: ReadinessEvent): Readiness {
  switch (e.type) {
    case 'opened':
      return { doc: e.doc, webViewLoaded: s.doc === e.doc && s.webViewLoaded, positionLoaded: false, restored: false }
    case 'webViewLoaded': return { ...s, webViewLoaded: true }
    case 'positionLoaded': return { ...s, positionLoaded: true }
    case 'restoreFired': return { ...s, restored: true }
  }
}

export const readyToRestore = (s: Readiness) => s.webViewLoaded && s.positionLoaded && !s.restored
