import type { MutableRefObject, RefObject } from 'react'
import type { WebView } from 'react-native-webview'
import type { BookmarkDto, TextPosition } from '@textstack/shared'
import type { PdfNewerOffer } from './readerSource'
import type { SessionJump } from '../../lib/sessionMath'

/** Which catalog the book belongs to. Drives the FK column used by highlights,
 *  vocab and reading-session — the ONLY thing that genuinely differs between the
 *  public-library reader and the user-uploaded-book reader. */
export type ReaderSource =
  | { kind: 'edition'; id: string | null; idRef: MutableRefObject<string | null>; slug: string }
  | { kind: 'userbook'; id: string | null; idRef: MutableRefObject<string | null> }

/** A loaded chapter, normalised across both data sources. */
export interface ReaderShellChapter {
  id: string
  title: string
  html: string
  prev?: { slug: string; title?: string } | null
  next?: { slug: string; title?: string } | null
}

export interface ReaderShellProps {
  source: ReaderSource
  /** Owned by the route (so its data hooks can inject too); attached to the WebView by the shell. */
  webViewRef: RefObject<WebView | null>
  injectJs: (js: string) => void

  /** A loaded chapter — the route handles loading/error and only renders the shell once ready. */
  chapter: ReaderShellChapter
  /** URL slug of the current chapter. */
  chapterSlug: string
  /** 3rd arg to buildReaderHtml (chapter slug baked into 'progress' messages).
   *  Public passes its chapterSlug; user-book historically passed undefined. */
  htmlChapterSlug?: string
  bookTitle: string | null
  /** Language of the book's text. Absent → the app language. See bookLanguage.ts (M5). */
  bookLanguage?: string | null
  chapters: { slug: string; title: string; chapterNumber?: number; wordCount?: number | null; sourceStartPage?: number | null }[]
  chaptersLoading: boolean

  // Progress/session machinery — refs created by the route (its progress + session
  // hooks read them); mutated from the WebView 'progress' message (useReaderSessionFeed).
  progressRef: MutableRefObject<number>
  scrollOffsetRef: MutableRefObject<number>
  currentChapterSlugRef: MutableRefObject<string | null>
  bookProgressRef: MutableRefObject<number | null>
  positionRef: MutableRefObject<TextPosition | null>
  totalWordCountRef: MutableRefObject<number>
  bumpProgress: () => void
  /** Returns the server write when one went out (Discuss waits for it). */
  saveProgress: () => Promise<unknown> | void

  /** Signalled once the WebView finishes loading. The shared persistence
   *  layer gates scroll-restore on this + the async saved-position fetch, so
   *  restore can't race the load (the "always returns to top" bug). */
  onWebViewLoaded: () => void

  /** The WebView acknowledged a restore, carrying back the id it was issued with. */
  onRestoreLanded: (restoreId: number, scrollY?: number) => void
  /** The chapter's restore has landed (or there was nothing to restore). M8. */
  positionSettled: boolean
  /** Where a programmatic restore stands — its travel and its distance are not reading. */
  sessionJumpRef: MutableRefObject<SessionJump>
  onDocumentRebuild: () => void
  reflow: (buildJs: (restoreId: number) => string) => void

  /** Put a chapter on the device before opening it (end-of-chapter block). */
  ensureChapter: (slug: string) => Promise<void>
  /** The chapter is in SQLite — a local read, no network. */
  isChapterOnDevice: (slug: string) => Promise<boolean>

  /** Perform the actual router.replace to a chapter slug (path differs per source). */
  onNavigateChapter: (slug: string) => void
  /** Filled with `navigateChapter` (useReaderChapterNav), for the persistence layer's prompt. */
  chapterNavigatorRef: MutableRefObject<((slug: string) => void) | null>

  // Bookmarks (state + mutations owned by the route; locator→slug mapping differs).
  // "is the ACTIVE chapter bookmarked" is computed in the shell since activeSlug lives there.
  bookmarks: BookmarkDto[]
  onToggleCurrentBookmark: (slug: string) => void
  onDeleteBookmark: (id: string) => void
  bookmarkChapterSlug: (b: BookmarkDto) => string

  /** Book title ref (vocab-save payload). */
  bookTitleRef: MutableRefObject<string | null>
  /** Word count of the loaded chapter (reading-session input). */
  wordCount: number
  /** Explain sheet "bookId" — editionId for public, undefined for user-book. */
  explainBookId?: string
  /** ADR-012 S4b — render the ORIGINAL PDF (pdf.js viewer) instead of the reflow
   *  HTML. Same shell, one branch: the WebView source swaps and the reflow-only
   *  scroll/progress/chapter-end message branches go inert. */
  original?: boolean
  /** Range-enabled URL of the original PDF (Bearer injected into pdf.js, not the URL). */
  originalFileUrl?: string | null
  /** 1-based page to open the PDF at (chapter start page). Wins over the server
   *  resume page. Null → use the server resume page, else page 1. */
  originalInitialPage?: number | null
  /** Server-persisted resume page (parsed from the `page:<N>` locator). Used
   *  when the chapter carries no page. (ADR-012 S4c) */
  originalResumePage?: number | null
  /** False until the device's resume page has been read — the initial jump waits
   *  on this (ignored when `originalInitialPage` is set). Never waits on a network. */
  originalResumeReady?: boolean
  /** A page the server holds that is provably newer than the one the PDF opened
   *  at, found after the open. See the effect that consumes it. */
  originalNewerPage?: PdfNewerOffer | null
  /** Persist a PDF page position to server progress (debounced by the source).
   *  Never feeds the word-based reading session. */
  persistPdfPage?: (page: number, numPages: number) => void
  /** Toggle a page bookmark for the current PDF page (original mode). */
  onTogglePageBookmark?: (page: number) => void
  /** Whether a given 1-based page has a page bookmark. */
  isPageBookmarked?: (page: number) => boolean
  /** Drop into the reflow reader on a corrupt PDF. Undefined when no reflow
   *  chapters exist (→ hard error). */
  onForceReflow?: () => void
}
