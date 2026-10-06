import type { MutableRefObject, RefObject } from 'react'
import type { WebView } from 'react-native-webview'
import type { BookmarkDto, TextPosition } from '@textstack/shared'
import type { ReaderSource, ReaderShellChapter } from './ReaderShell'

/**
 * The single normalized contract for the reader. Both catalog (edition) and
 * user-uploaded books are loaded into ONE `ReaderRuntime` shape by their
 * respective source hooks (`useEditionReaderSource` / `useUserBookReaderSource`),
 * which `<Reader>` then renders. The ONLY differences between the two
 * catalogs (data fetch, FK keying, progress I/O) live behind these types —
 * everything downstream is a single code path, so a fix lands in both at once.
 *
 * This is the structural fix for the recurring "two readers drifted" class of
 * bugs (e.g. user-book lost its percent-restore fallback because the restore
 * effect was copy-pasted and one copy fell behind).
 */

/** Chapter-list entry — drives TOC + book-progress word-count weighting. */
export interface ReaderChapterMeta {
  slug: string
  title: string
  chapterNumber?: number
  wordCount?: number | null
  /** 1-based PDF page where this chapter starts (Original layout, ADR-012 S4c).
   *  Drives TOC → page jumps. Null/undefined for EPUB / unknown. */
  sourceStartPage?: number | null
}

/**
 * Immutable snapshot of the live scroll state, handed to a source's
 * `persist()`. Built by `useReaderPersistence` from the live refs so the
 * source layer does pure I/O and never reads refs directly (testable).
 */
export interface ProgressSnapshot {
  /** Server chapter id, or null for an offline-cached chapter — the offline
   *  store keys chapters by slug and has no id to give. Sources must persist
   *  locally regardless and skip only the server write. */
  chapterId: string | null
  chapterSlug: string
  /** 0..1 within the active chapter. */
  chapterPercent: number
  /** Pixel scroll offset — builds the `scroll:<slug>:<offset>` resume locator.
   *  Kept for the compatibility write; `position` is what a current build reads. */
  scrollOffset: number
  /** Where the reader is IN THE TEXT — survives a reflow, a re-parse and a
   *  different device, none of which a pixel offset survives. Null when the
   *  reading line lands somewhere with no text under it. */
  position: TextPosition | null
  /** 0..1 across the whole book, or null until chapters/word-counts resolve. */
  bookPercent: number | null
  /** Epoch ms — LWW key for server + local merge. */
  updatedAt: number
}

/** Saved resume position for a chapter. Every field may be null.
 *
 *  Tried in order: the text anchor, then the pixel offset it is replacing, then
 *  the coarse percent. The anchor is the only one that is still true after the
 *  text has reflowed, so it goes first; the other two are what a row written by
 *  an older build has to offer. */
export interface SavedPosition {
  position: TextPosition | null
  offset: number | null
  percent: number | null
}

/** A position the server holds that is provably newer than the local record a
 *  chapter opened from (see `serverProvablyNewer`). Found in the background,
 *  after the open — never awaited by it. */
export interface PdfNewerOffer {
  page: number
  at: number
  /** Found on a return to the foreground: "moved" is measured from the page at return. */
  onReturn?: boolean
}

export interface NewerPosition {
  chapterSlug: string
  saved: SavedPosition
  /** What the prompt calls it — the chapter's title. */
  label: string
}

/**
 * Everything `<Reader>` + `<ReaderShell>` need, normalized across catalogs.
 */
export interface ReaderRuntime {
  // Shell keying / WebView ownership.
  source: ReaderSource
  webViewRef: RefObject<WebView | null>
  injectJs: (js: string) => void

  // Chapter + load state.
  chapter: ReaderShellChapter | null
  loading: boolean
  chapterError: 'offline' | 'notfound' | null
  chapterSlug: string
  htmlChapterSlug?: string

  // Book metadata.
  bookTitle: string | null
  bookTitleRef: MutableRefObject<string | null>
  /** Language of the book's text (an upload's own). Absent → the app language (catalog). M5. */
  bookLanguage?: string | null
  chapters: ReaderChapterMeta[]
  chaptersLoading: boolean
  wordCount: number

  // Live scroll refs — written by ReaderShell from the WebView 'progress' msg,
  // read by useReaderPersistence to build the ProgressSnapshot.
  progressRef: MutableRefObject<number>
  scrollOffsetRef: MutableRefObject<number>
  currentChapterSlugRef: MutableRefObject<string | null>
  /** Latest logical position reported by the WebView. */
  positionRef: MutableRefObject<TextPosition | null>
  bookProgressRef: MutableRefObject<number | null>
  totalWordCountRef: MutableRefObject<number>

  // Persistence (from the shared useReaderPersistence hook).
  /** Returns the server write when one went out, so Discuss can wait for it. */
  saveProgress: () => Promise<unknown> | void
  bumpProgress: () => void
  /** Called by ReaderShell once the WebView finishes loading — gates the
   *  scroll-restore so it can't race the async saved-position fetch. */
  onWebViewLoaded: () => void
  /** The WebView acknowledged a restore, carrying back the id it was issued with. */
  onRestoreLanded: (restoreId: number) => void
  /** The chapter's restore has landed (or there was nothing to restore). M8. */
  positionSettled: boolean
  /** The document is about to be rebuilt — told before the new one loads. */
  onDocumentRebuild: () => void
  /** Mint a restore id and shut the write gate behind it, for a move the reader
   *  did not make (a typography reflow). */
  beginReflow: () => number

  /** Put a chapter on the device (cache first, then network) before opening it.
   *  Rejects when it is neither cached nor reachable. */
  ensureChapter: (slug: string) => Promise<void>
  /** The chapter is in SQLite — a local read, no network. */
  isChapterOnDevice: (slug: string) => Promise<boolean>

  // Navigation (path differs per source).
  onNavigateChapter: (slug: string) => void
  /** The shell registers its navigateChapter here, so a chapter change started
   *  by the persistence layer (the newer-position prompt) carries the visit too. */
  chapterNavigatorRef: MutableRefObject<((slug: string) => void) | null>

  // Bookmarks.
  bookmarks: BookmarkDto[]
  onToggleCurrentBookmark: (slug: string) => void
  onDeleteBookmark: (id: string) => void
  bookmarkChapterSlug: (b: BookmarkDto) => string

  // Explain sheet bookId — editionId for catalog, undefined for user-book.
  explainBookId?: string

  // --- Original-layout PDF (ADR-012 S4b) ------------------------------------
  // Set by `useUserBookReaderSource` when the upload has a renderable PDF and
  // reflow isn't force-selected. When true, the shell renders the pdf.js viewer
  // WebView instead of the reflow HTML (one shell, branch inside). Absent/false
  // for editions and reflow user-books.
  original?: boolean
  /** Absolute, Range-enabled URL of the original PDF (mobile injects the Bearer
   *  into pdf.js httpHeaders — the URL carries no token). Null unless `original`. */
  originalFileUrl?: string | null
  /** 1-based page to open the PDF at — the current chapter's start page. When
   *  set it WINS over the server resume page (the user chose this chapter). Null
   *  → fall back to the server resume page, else page 1. */
  originalInitialPage?: number | null
  /** Resume page from the device's own record (`page:<N>`). Used when the
   *  chapter carries no page — it loses to `originalInitialPage`. A newer page
   *  from the server arrives later as `originalNewerPage`. (ADR-012 S4c) */
  originalResumePage?: number | null
  /** False until the LOCAL resume page has been read (device only, never the
   *  network). Ignored when `originalInitialPage` is set (chapter jump is instant). */
  originalResumeReady?: boolean
  /** A page the server holds that is provably newer than the local one the PDF
   *  opened at — found in the background after the open, or on a return to the
   *  foreground (`onReturn`). The shell adopts it, moves there, or asks, by
   *  `decideNewerPosition`. `at` makes every offer a new event, even for a page
   *  offered before. */
  originalNewerPage?: PdfNewerOffer | null
  /** Persist a PDF page position to server progress (page fraction → the same
   *  ProgressPercent field the library card reads). Debounced by the source. The
   *  shell calls this on the throttled `pdfPage` message; it never feeds the
   *  word-based reading session. (ADR-012 S4c) */
  persistPdfPage?: (page: number, numPages: number) => void
  /** Toggle a page bookmark (`locator: page:<N>`, `chapterId: null`) for the
   *  current PDF page. Original mode only. */
  onTogglePageBookmark?: (page: number) => void
  /** Whether the given 1-based page currently has a page bookmark. */
  isPageBookmarked?: (page: number) => boolean
  /** Drop out of Original layout into the reflow reader (ADR-012 S4c corrupt-PDF
   *  fallback). No-op / undefined when the book has no reflow chapters. */
  onForceReflow?: () => void
}

export type { ReaderShellChapter }
