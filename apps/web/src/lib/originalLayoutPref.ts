import { parsePdfPageLocator, serverProvablyNewer } from '@textstack/shared'

// Resume-only PDF page position for the Original-layout view, remembered in
// localStorage, with a write stamp. The old per-book
// "Original layout" opt-in was removed in ADR-012 — Original is now the default
// for user-uploaded PDFs, so there's no layout preference to persist.

const PAGE_KEY = (bookId: string) => `reader.pdfPage.${bookId}`

/** Resume-only PDF page position. NOT synced to server progress. */
export function readPdfPage(bookId: string): number | null {
  try {
    const raw = localStorage.getItem(PAGE_KEY(bookId))
    if (!raw) return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 1 ? n : null
  } catch {
    return null
  }
}

/**
 * `at` stamps the write (this browser's clock) under a sibling key, so a server page can be
 * compared with it on client stamps (`serverProvablyNewer`). Pass the stamp the server write of
 * the same page carries, so this device's own write never reads back as "newer elsewhere".
 */
export function writePdfPage(bookId: string, page: number, at: number = Date.now()): void {
  try {
    localStorage.setItem(PAGE_KEY(bookId), String(page))
    localStorage.setItem(STAMP_KEY(bookId), String(at))
  } catch {
    /* best effort */
  }
}

const STAMP_KEY = (bookId: string) => `reader.pdfPageAt.${bookId}`

/** This device's page record as a stamp, for `serverProvablyNewer`. Null: never stamped. */
export function readPdfPageStamp(bookId: string): { updatedAt: number } | null {
  try {
    const n = Number(localStorage.getItem(STAMP_KEY(bookId)))
    return Number.isFinite(n) && n > 0 ? { updatedAt: n } : null
  } catch {
    return null
  }
}

/**
 * The server's `page:<N>` — only when it is provably newer than this device's page (another
 * device read on). Otherwise null, and the local page opens. A server row read once at mount
 * used to win unconditionally, so switching reflow → Original reopened at the page the book
 * was opened on, not the one just read to, and saved it (R4 review #4).
 */
export function serverResumePage(
  bookId: string,
  row: { locator?: string | null; clientUpdatedAt?: string | null } | null | undefined,
): number | null {
  const page = parsePdfPageLocator(row?.locator)
  return page != null && serverProvablyNewer(readPdfPageStamp(bookId), row) ? page : null
}
