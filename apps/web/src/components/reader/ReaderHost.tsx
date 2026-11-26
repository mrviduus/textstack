import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CHAPTER_TEXT_MS, createDiscussLocks, createDiscuss, fillBookMeta, runDiscuss, syncTocIfMissing, syncApi, type PagePosition, type FileDetails } from '@textstack/shared'
// ponytail: deep imports of apps/mobile source. The page and its helpers live there until the engine's home
// is settled (#1128, ADR-032); moving them on the mobile side breaks this file's tsc, visibly, not silently.
import { createOpenTracker, isBookKey, type Take } from '../../../../../packages/reader/src/openTracker.mjs'
import { READER_FRAME_PATH } from '../../../../../packages/reader/src/framePath.mjs'
import { createDeadlines, openedDeadlineMs, READY_DEADLINE_MS, type Overdue } from '../../../../../packages/reader/src/deadlines.mjs'
import { readSelection } from '../../../../../packages/reader/src/selection.mjs'
import { readDescribed } from '../../../../../packages/reader/src/describe.mjs'
import { DESCRIBE_MS } from '../../lib/describeBook'
import { createHostMoves, hidesBarsOnRelocate, keyAction, NAV_KEYS, readDir, readKey, readLightbox, readRelocate, readTap, takenWithoutBook, type NavKey } from '../../../../../packages/reader/src/chrome.mjs'
import { popupStep, readLang, readWord, type Popup, type PopupEvent } from '../../../../../packages/reader/src/wordPopup.mjs'
import { savesWords } from '../../../../../packages/reader/src/vocabSave.mjs'
import { ttsLang } from '../../../../../packages/reader/src/listen.mjs'
import { ReaderPopups, type HighlightEditor } from './ReaderPopups'
import { noteChange, readHighlightList, readHighlightRemoved, readHighlightTap, type HighlightItem } from '../../../../../packages/reader/src/highlights.mjs'
import { showsFinishBook } from '../../../../../packages/reader/src/finishBook.mjs'
import { FinishBook } from './FinishBook'
import { readBookmarkList, type BookmarkList } from '../../../../../packages/reader/src/bookmarks.mjs'
import { chapterKey, offersDiscuss, readChapterEnd, readChapterText, type ChapterEnd } from '../../../../../packages/reader/src/chapters.mjs'
import { ChapterDiscuss, type DiscussState } from './ChapterDiscuss'
import { syncStore } from '../../api/sync'
import { listOAuthGrants } from '../../api/oauth'
import { readToc, readTocMessage, tocAround, type TocEntry } from '../../../../../packages/reader/src/toc.mjs'
import { createSessionTracker, SESSION_HEARTBEAT_MS, type EndedSession } from '../../../../../packages/reader/src/sessionTracker.mjs'
import { flushPendingSessions, queueReadingSession } from '../../hooks/useReadingSession'
import { useAuth } from '../../context/AuthContext'
import { trackReadingSessionEnd } from '../../lib/analytics'
import { SectionNav, TocDrawer } from './ReaderToc'
import { SearchDrawer } from './ReaderSearch'
import { NO_SEARCH, createSearchRenders, readSearchResults, searchOpened, searchReset, searchStart, searchTake, type Search } from '../../../../../packages/reader/src/search.mjs'
import { useImmersiveMode } from '../../hooks/useImmersiveMode'
import { TimeLeft, percentText, type TimePlace } from './TimeLeft'
import { useTranslation } from '../../hooks/useTranslation'
import { readItem, writeItem } from '../../lib/safeLocalStorage'
import { useGlosses, usePageSettings, ReaderSettingsDrawer } from './ReaderSettings'
import type { MarkWord } from '../../../../../packages/reader/src/wordMarks.mjs'
import { createReaderSync, type ReaderSync, type SaveStatus, type SyncTarget } from '../../lib/readerSync'

/**
 * The V2 reader page (ADR-029) on the web: one host for the dev route (/dev/reader, a picked file) and the
 * production route (/:lang/library/my/:id/read-v2, the V2 file's bytes), #1225. It drives the contract the
 * Android host drives (packages/reader/README.md): ready → openBytes → opened → restore → restored,
 * then store / relocate / word / openLink. Reader data (position, highlights): in localStorage on the dev route
 * (`dev`) only; on the production route on the server, for a book with a `sync` target (#1226:
 * lib/readerSync.ts, a CBZ page position too (`page-name`, #1188); another device's newer place
 * is offered, #1232). The layout is a
 * localStorage setting on both.
 */

/**
 * A book to open: a new object opens it (the same object again does nothing). `bytes` are transferred. `sync`:
 * the server book and file these bytes are; its reader data is restored from and saved to the server.
 */
export interface HostBook { bytes: ArrayBuffer; name: string; sync?: SyncTarget }
/** The page's `opened` message, as far as hosts read it. */
export interface HostOpenedMessage {
  /** `epub` / `mobi` / `fb2` / `cbz` / `pdf` (a PDF's contents come later, as `toc`). */
  format?: string
  title?: string
  author?: string
  annotatable?: boolean
  /** #1314: a bookmark can be made somewhere in this book. */
  bookmarkable?: boolean
  reflowable?: boolean
  /** #1315: strictly `true` where the page can search the book (not a CBZ or a PDF). */
  searchable?: unknown
  /** Untrusted: read through readLang / ttsVoice only. */
  lang?: unknown
  book: { sha256: string; size: number; name?: string }
}

const storeKey = (sha256: string) => `v2reader:store:${sha256}`
/** The reader's layout, a per-user setting (#1128): paginated unless the reader chose scrolled. */
const FLOW_KEY = 'v2reader:flow'
type Flow = 'paginated' | 'scrolled'
/** The save line per sync status ('saved' shows none). */
const SAVE_MESSAGE = { unsaved: 'v2Reader.unsaved', reopen: 'v2Reader.reopen', noHighlights: 'v2Reader.noHighlights' } as const

/**
 * The page as its own same-origin document (#1219): a no-store shell with a fresh nonce per response and the
 * page code as a cached script (frame.mjs; the dev/preview servers through vite.config.ts, nginx in
 * production). Not srcdoc: that inherits this document's CSP, which refuses the page's scripts.
 */
const FRAME_SRC = READER_FRAME_PATH
/** The share call (#1316), a seam for the host tests. */
export const discussApi = { shareChapter: syncApi.shareChapter }
/** The frame's id: the skip link's target. */
const BOOK_ID = 'v2-reader-book'
/**
 * No `ready` by then: the frame is not the page (a wrong path, an error, the SPA's own index.html nested in
 * it, a refused script). No `opened`/`open-failed` by the open's deadline: the page is stuck on the file. Both
 * said on screen with Retry, since nothing else ever would (#1080 item 3, #1227; the rule: deadlines.mjs). The
 * default suits a local server; a route over the network passes its own.
 */
export { READY_DEADLINE_MS }

/**
 * The open in flight: `name` is unique per open and echoed in `opened`/`open-failed`, so a superseded
 * answer is dropped. `bytes` until the page has been handed them (it may not be `ready` yet).
 */
type Opening = { name: string; originalName: string; bytes?: ArrayBuffer; sync?: SyncTarget }

type HostKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat' | 'target'>
/**
 * A keydown on the host's own document as a navigation key (#1263), or null. The page's `navKey` takes keys on
 * its document body only; here a focused bar control keeps only the keys it uses itself, so after a click on
 * Next › the arrows still turn: Space on a button or link, every key in a field. Inside a dialog, Escape only.
 * Escape always (the bars). No
 * Ctrl/Alt/Meta, no Shift+arrow (it extends a selection), as `navKey`.
 */
export function hostNavKey(e: HostKeyEvent): { key: NavKey; shift: boolean; repeat: boolean } | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const key = (e.key === ' ' ? 'Space' : e.key) as NavKey
  if (!NAV_KEYS.includes(key) || (e.shiftKey && key.startsWith('Arrow'))) return null
  const k = { key, shift: !!e.shiftKey, repeat: !!e.repeat }
  if (key === 'Escape') return k
  const el = e.target instanceof Element ? e.target : null
  // An open dialog (settings, contents) is modal: no key behind it turns the page (#1260 review).
  if (el?.closest('[role="dialog"]')) return null
  if (el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return null
  if (key === 'Space' && el?.closest('button, a[href], summary, [role="button"]')) return null
  return k
}

/**
 * A `store` from the page, untrusted (the frame renders the book): the message, or the page's `flush()` return value
 * read across the same-origin frame (#1286), which may be any object (a getter, a Proxy). Each field is read once.
 */
export function readStore(m: unknown): { key: string; json: string } | null {
  const o = m as { type?: unknown; key?: unknown; json?: unknown } | null | undefined
  const type = o?.type, key = o?.key, json = o?.json
  return type === 'store' && typeof key === 'string' && typeof json === 'string' ? { key, json } : null
}

/**
 * The page's latest `store` (#1286), read synchronously by calling its `flush()` in the same-origin frame: where
 * a posted `store` comes too late (this document's `pagehide`, the host's unmount). Any failure (no frame, mid
 * navigation, a throw, a malformed answer) is null: today's behaviour, never an exception.
 */
export function pageLastStore(frame: HTMLIFrameElement | null): { key: string; json: string } | null {
  try {
    return readStore((frame?.contentWindow as { __fol?: { flush?: () => unknown } } | null | undefined)?.__fol?.flush?.())
  } catch {
    return null
  }
}

/**
 * An ended reading session (#1313) to the session queue, under an id of its own: a resend is the same session.
 * GA4's session end as the legacy reader sends it: for a signed-in reader (a guest too) only.
 */
function sendSession(e: EndedSession | null, authenticated: boolean) {
  if (!e) return
  const { book, ...session } = e
  queueReadingSession({ ...session, userBookId: book, clientSessionId: crypto.randomUUID() })
  const { durationSeconds, wordsRead, startPercent, endPercent } = session
  // No ids: V2 book ids are not legacy's UserBook ids, which `user_book_id` holds.
  if (authenticated) trackReadingSessionEnd({ durationSeconds, wordsRead, startPercent, endPercent, editionId: null, userBookId: null })
}

interface Props {
  book: HostBook | null
  /** The page took a book (after the open tracker's checks): the dev route records it in its library. */
  onOpened?: (m: HostOpenedMessage, originalName: string) => void
  /** Controls before the reader's own (the dev route's file input). */
  toolbar?: ReactNode
  /** In the states box above the frame (the dev route's library; the production route's load error). */
  children?: ReactNode
  /** The heading until the first open (the prod route clears it on a load error). */
  idleHeading?: string
  /** How long the frame may take to send `ready`. */
  readyDeadlineMs?: number
  /**
   * Retry after a deadline reloads the frame; an open whose bytes already went into the old frame is gone with
   * it, and this asks the route for the book again (a new object). Without it (the dev route) the reader picks again.
   */
  onReload?: () => void
  /** The dev route: reader data in localStorage, the `restore:` line and a stub translation label on a tapped word. */
  dev?: boolean
  /** The top bar's back link (none without it: the dev route). */
  backUrl?: string
  /** #1312: `?highlight=<id>`: the open book jumps to that highlight once the page lists it (drawn). */
  highlightId?: string | null
  /** The jump to `highlightId` was made: the route drops the parameter, so a reload does not jump (and save) again. */
  onHighlightShown?: () => void
  /** `?contents=1` (the book page's Contents): the Contents panel opens once the first book is open, if it has contents. */
  openContents?: boolean
  /** The panel opened for `openContents`: the route drops the parameter, so a reload opens at the book. */
  onContentsShown?: () => void
}

export function ReaderHost({ book, onOpened, toolbar, children, idleHeading = '', readyDeadlineMs = READY_DEADLINE_MS, onReload, dev = false, backUrl, highlightId, onHighlightShown, openContents = false, onContentsShown }: Props) {
  const { t } = useTranslation()
  /** The latest `t`, for the message handler (made once). */
  const tRef = useRef(t)
  tRef.current = t
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  /** Which page answer belongs to which open (openTracker.mjs): a book kept on screen, a stale `restored`. */
  const [tracker] = useState(() => createOpenTracker<Opening, HostOpenedMessage>())
  /** The reading session (#1313, sessionTracker.mjs): only a synced book's, sent through the session queue. */
  const [sessions] = useState(createSessionTracker)
  const { isAuthenticated, user, isGuest } = useAuth()
  /** #1316: the account a Discuss runs under (its guard); the ref for the run in flight. */
  const accountId = user?.id ?? null
  const account = useRef(accountId)
  account.current = accountId
  const authenticated = useRef(isAuthenticated)
  authenticated.current = isAuthenticated
  const endSession = (e: EndedSession | null) => sendSession(e, authenticated.current)
  /** #1426: the page's `describe` answers awaited, by request id. */
  const described = useRef(new Map<string, (d: FileDetails | null) => void>())
  /** The open book's details and cover from the page, or null (another open since, no answer in time, an error). */
  const describeOpen = (o: Opening) => new Promise<FileDetails | null>((done) => {
    // Calls run in order in the page: with no open posted since `o`'s, the book it reads is `o`'s.
    if (opening.current !== o || !ready.current) return done(null)
    const id = crypto.randomUUID()
    const finish = (d: FileDetails | null) => { clearTimeout(timer); described.current.delete(id); done(d) }
    const timer = setTimeout(() => finish(null), DESCRIBE_MS)
    described.current.set(id, finish)
    call('describe', [id])
  })
  const opens = useRef(0)
  const lastBook = useRef<HostBook | null>(null)
  const onOpenedRef = useRef(onOpened)
  onOpenedRef.current = onOpened
  const onReloadRef = useRef(onReload)
  onReloadRef.current = onReload
  const onHighlightShownRef = useRef(onHighlightShown)
  onHighlightShownRef.current = onHighlightShown
  /** null: `idleHeading` (nothing opened, or the open was given up); '' after a failed open: no title of another book (#1168). */
  const [heading, setHeading] = useState<string | null>(null)
  const [flow, setFlow] = useState<Flow>(() => (readItem(FLOW_KEY) === 'scrolled' ? 'scrolled' : 'paginated'))
  const flowRef = useRef(flow)
  /** The reading settings (#1260): sent whole on `ready` and on every change; the theme colours the bars. */
  const { settings, update: updateSettings, ttsSpeed, updateTtsSpeed } = usePageSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * #1271: the saved words the page marks (ReaderPopups' vocabulary, in memory) and whether their translations show
   * (the legacy reader's setting). Sent whenever either changes and to every new frame (`ready`): the page keeps them
   * across opens and marks each section as it loads.
   */
  const [glosses, setGlosses] = useGlosses()
  const marks = useRef<{ words: MarkWord[]; show: boolean }>({ words: [], show: glosses })
  const sendMarks = () => { if (ready.current) call('markWords', [marks.current.words, marks.current.show]) }
  /** The direction the open book pages in (`opened`, then every `relocate`): the arrow keys follow it. */
  const pageDir = useRef<'ltr' | 'rtl'>('ltr')
  /** `opened.annotatable`: false on a CBZ (images only) and a PDF (no highlights yet): no highlight button (the page refuses it too). */
  const [annotatable, setAnnotatable] = useState(true)
  /** False for a fixed-layout book (CBZ): flow changes nothing there. */
  const [reflowable, setReflowable] = useState(true)
  /** The percent read, of the last relocate shown ('' : none); the current contents entry's title is added where it is drawn. */
  const [status, setStatus] = useState('')
  /** The place of the relocate `status` shows, for the time left (#1262). */
  const [timePlace, setTimePlace] = useState<TimePlace | null>(null)
  const [restored, setRestored] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** A deadline the frame missed (deadlines.mjs); a late answer clears it. */
  const [overdue, setOverdue] = useState<Overdue>(null)
  /** #1204: the open PDF's reader was terminated (a page that never finished): its pages stay blank until Retry reopens it. */
  const [stopped, setStopped] = useState(false)
  const [deadlines] = useState(() => createDeadlines(setOverdue))
  /** The size of the open last handed to the page: its `opened` deadline (said in the message). */
  const openedBytes = useRef(0)
  /** A new value is a new frame (Retry after a deadline). */
  const [frameLoad, setFrameLoad] = useState(0)
  /** The open book's server sync (null: none, or the dev route); one per take, closed (after a last write) on the next. */
  const sync = useRef<ReaderSync | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  /** The production route: the server's highlights have landed, so highlighting is offered (B, #1226). */
  const [highlightsReady, setHighlightsReady] = useState(false)
  /** The open's reading-state read failed: no session; Retry reads again, then restores (no read, no writes). */
  const [readFailed, setReadFailed] = useState(false)
  const retryRead = useRef<(() => void) | null>(null)
  /** Another device's newer place, offered (#1232, ADR-019 `prompt`); the newest one shown until answered or a new open. */
  const [offer, setOffer] = useState<PagePosition | null>(null)
  /**
   * Finish book (#1266): the book's end is on screen (`relocate.atEnd`); the synced book's format and its
   * completion (undefined: no session, or its reading state not read yet: no block; null: not finished).
   */
  const [atEnd, setAtEnd] = useState(false)
  const [finish, setFinish] = useState<{ format: string; completedAt?: string | null } | null>(null)
  /**
   * Discuss this chapter (#1316): the chapter whose end is on screen (`relocate.chapterEnd`, the page's own test),
   * the server book the open bytes are (null: none, so no Discuss), each chapter's share as far as it got (kept
   * while the book is open: a reader who scrolls away and back finds it), and the shared controller (the page's
   * `chapter-text` answers awaited, one operation id per chapter so a retry replays the first share).
   */
  const [chapterEnd, setChapterEnd] = useState<ChapterEnd | null>(null)
  const [discussBook, setDiscussBook] = useState<{ bookId: string; fileId: string; title: string; author: string | null; language: string | null } | null>(null)
  const [discussStates, setDiscussStates] = useState<Record<string, DiscussState>>({})
  const [discussLocks] = useState(createDiscussLocks)
  const [discuss] = useState(() => createDiscuss({
    askPage: (request, c) => call('chapterText', [request, c.tocIndex, c.section]),
    share: (bookId, body) => discussApi.shareChapter(bookId, body),
    newId: () => crypto.randomUUID(),
    timeoutMs: CHAPTER_TEXT_MS,
  }))
  /**
   * The open book's contents (#1261, toc.mjs) and the reader's place in them; shown only while `reading`. The
   * place is cleared where an open starts, not on `opened`: the page posts a book's first relocate before its
   * `opened`, and a fixed-layout book sends no other until a page turn.
   */
  const [toc, setToc] = useState<TocEntry[]>([])
  const [tocIndex, setTocIndex] = useState<number | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  /** `openContents`, taken once per mount by the first book opened. */
  const contentsOnOpen = useRef(openContents)
  const onContentsShownRef = useRef(onContentsShown)
  onContentsShownRef.current = onContentsShown
  /**
   * #1315: in-book search (search.mjs, one rule for both hosts): the search the page was last asked and whether the open
   * book can be searched (the ref for the message handler, set with the state: an answer may come before the
   * re-render); the drawer, keyed by the open so a new book's starts empty.
   */
  const [search, setSearchState] = useState<Search>(NO_SEARCH)
  const searchRef = useRef<Search>(NO_SEARCH)
  const setSearch = (s: Search) => {
    searchRef.current = s
    setSearchState(s)
  }
  /** Streamed results are put on screen at most once per SEARCH_RENDER_MS (search.mjs): not a render of the whole reader per section. */
  const [renderSearch] = useState(() => createSearchRenders(() => setSearchState(searchRef.current)))
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchBook, setSearchBook] = useState(0)
  /**
   * The bars (#1263): hidden 3 s after `opened`, by a page turn (tap, key) and by the reader moving the place
   * (`relocate.moved`, either flow) unless a bar button or the taken offer moved it; a centre tap toggles them,
   * Esc and focus on a bar show them. A new open shows them (its title is the opening state) and they stay up
   * until `opened`. The states box above the frame never hides.
   */
  const [reading, setReadingState] = useState(false)
  /**
   * A book is on screen and no open is in flight: only then do taps and keys turn pages or hide the bars. Set at
   * once with the state: the page's next message may come before the re-render.
   */
  const readingRef = useRef(false)
  const setReading = (v: boolean) => {
    readingRef.current = v
    setReadingState(v)
  }
  /**
   * Desktop (a fine pointer): the bars follow the mouse (a move shows them, 3 s without one hides them, never while the
   * pointer or keyboard focus is on a bar), and a click in the book never turns a page: the footer's arrows and the keys do.
   */
  const [mouse] = useState(() => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches)
  // Keyboard focus only (`:focus-visible`): a bar button keeps the focus a click gave it, and must not pin the bars.
  const onBar = () => [header.current, footer.current].some((b) => b?.matches(':hover') || b?.querySelector(':focus-visible'))
  const { immersiveMode: barsHidden, showBars, hideBars, pointerMoved } = useImmersiveMode(true, !reading, mouse ? onBar : undefined)
  const onMouseMove = () => { if (mouse && readingRef.current && !lightboxRef.current) pointerMoved() }
  const barsHiddenRef = useRef(barsHidden)
  barsHiddenRef.current = barsHidden
  const reflowableRef = useRef(reflowable)
  reflowableRef.current = reflowable
  /** The flow in effect: a fixed-layout book pages whatever the setting. */
  const effectiveFlow = (): Flow => (reflowableRef.current ? flowRef.current : 'paginated')
  /** A bar button's or the taken offer's move: its relocates keep the bars up (chrome.mjs). */
  const [hostMoves] = useState(() => createHostMoves())
  /**
   * The word popup or the selection toolbar (#1269, wordPopup.mjs `popupStep`: one rule for both hosts); the ref for
   * the message handler, set with the state. The book's language (`opened.lang`), `en` when it says none.
   */
  const [popup, setPopupState] = useState<Popup | null>(null)
  const popupRef = useRef<Popup | null>(null)
  const setPopup = (p: Popup | null) => {
    // The highlight editor closing, whatever closes it: its changed draft is written (#1312 review).
    const was = popupRef.current
    if (was?.kind === 'highlight' && !(p?.kind === 'highlight' && p.id === was.id)) flushDraft()
    popupRef.current = p
    setPopupState(p)
  }
  /**
   * #1265: the page shows an image full screen (its `lightbox` message): no key of this document turns, Escape closes it.
   * #1267: the bars and the states box are `inert` meanwhile, so Tab out of the page's dialog never lands on hidden bars.
   * The ref for the message handler, set with the state.
   */
  const lightboxRef = useRef(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const setLightbox = (v: boolean) => {
    lightboxRef.current = v
    setLightboxOpen(v)
  }
  const [bookLanguage, setBookLanguage] = useState('en')
  /** #1271: the language whose saved words are marked: the one words are saved under, none where it does not read (savesWords). */
  const [marksLanguage, setMarksLanguage] = useState<string | null>(null)
  /** #1272: the language Listen speaks the open book in (`opened.lang` as written, else `en`); null: no Listen. */
  const [ttsLanguage, setTtsLanguage] = useState<string | null>(null)
  /** The server book a tapped word is saved with (#1270): the production route's, when the bytes are its file's. */
  const [vocabBook, setVocabBook] = useState<{ id: string; title: string } | null>(null)
  /**
   * #1312: the open book's drawn highlights (the page's `highlight-list`, for the book taken last), the notes the dev
   * route keeps in memory (the production route's are the session's), a counter that re-renders after a note edit,
   * and the deep link's highlight still to jump to (once per open).
   */
  const [highlightList, setHighlightList] = useState<HighlightItem[]>([])
  /** #1314: the open book's bookmarks, the one on screen and whether one can be made here (the page's `bookmark-list`); null until it comes. */
  const [bookmarks, setBookmarks] = useState<BookmarkList | null>(null)
  /** `opened.bookmarkable`: a bookmark can be made somewhere in the open book (#1350: a PDF, a CBZ, a pre-paginated EPUB too, by page). */
  const [bookmarkable, setBookmarkable] = useState(false)
  const openedSha = useRef<string | null>(null)
  const devNotes = useRef(new Map<string, string | null>())
  const [, setNotesSeen] = useState(0)
  const pendingHighlight = useRef<string | null>(null)
  /**
   * #1312 review: the open highlight editor's draft (lifted here from the popup), the note it opened with and the session
   * of its book. Written by `flushDraft` whatever closes the editor: another popup, a tap in the book, a new open, leaving
   * the route (before the session's close), the tab hidden or closed (before the keepalive writes).
   */
  const editorDraft = useRef<{ id: string; text: string; from: string | null; session: ReaderSync | null } | null>(null)
  const writeNote = (id: string, note: string | null, session: ReaderSync | null) => {
    if (dev) devNotes.current.set(id, note)
    else session?.setNote(id, note)
    setNotesSeen((n) => n + 1)
  }
  /**
   * `keep`: the editor stays open (the tab hidden or closing, maybe kept): what was written becomes its baseline, so a
   * later Save (or Cancel, back to the note at opening) is compared with it, never with the note it opened with.
   */
  function flushDraft(keep = false) {
    const d = editorDraft.current
    editorDraft.current = null
    const note = d && noteChange(d.text, d.from)
    // One the server holds as deleted (elsewhere) is not edited: it leaves the page, nothing is saved (#1312 review).
    if (d && note !== undefined && d.session?.deleted(d.id)) call('removeHighlight', [d.id])
    else if (d && note !== undefined) writeNote(d.id, note, d.session)
    if (d && keep) editorDraft.current = { ...d, from: note === undefined ? d.from : note }
  }
  const main = useRef<HTMLElement>(null)
  const header = useRef<HTMLElement>(null)
  const footer = useRef<HTMLElement>(null)

  const call = (name: string, args: unknown[] = [], transfer: Transferable[] = []) =>
    frame.current?.contentWindow?.postMessage({ call: name, args }, location.origin, transfer)
  /**
   * A navigation key (chrome.mjs: forwarded by the page, or this document's own through navKey): one press, one
   * turn (a held key's repeats are dropped); 'bars' shows the bars. True: the key was the reader's.
   */
  const onNavKey = (k: ReturnType<typeof readKey>, inPopup = false) => {
    if (!k) return false
    // #1265: the lightbox is open (focus left the frame): Escape closes it, no other key turns behind it.
    if (lightboxRef.current) {
      if (k.key === 'Escape') call('closeLightbox')
      return true
    }
    // #1269: Escape with a popup open closes it and does nothing else (focus inside the word popup: its own keys).
    if (k.key === 'Escape' && popupRef.current) {
      if (!inPopup) closePopup(popupRef.current.kind === 'selection')
      return true
    }
    if (k.repeat) return true
    const action = keyAction({ ...k, dir: pageDir.current })
    if (action === 'bars') showBars()
    else if (action && readingRef.current) {
      call(action)
      hideBars()
    }
    return !!action
  }
  /** A bar button or the taken offer moving the book: the bars stay. */
  const hostMove = (name: string, args: unknown[] = []) => {
    hostMoves.start()
    call(name, args)
  }
  /** A tap, word or selection from the page (validated): what is open, and what the tap zones do (`popupStep`). */
  const onPopupEvent = (e: PopupEvent) => {
    // Desktop: no tap zones (scrolled flow has none), and the mouse, not a click, shows the bars.
    const { popup: next, turn } = popupStep(popupRef.current, e, { width: frame.current?.clientWidth, flow: mouse ? 'scrolled' : effectiveFlow(), dir: pageDir.current })
    setPopup(next)
    if (turn === 'toggle' && mouse) return
    if (turn === 'toggle') return barsHiddenRef.current ? showBars() : hideBars()
    if (!turn) return
    call(turn)
    hideBars()
  }
  /**
   * What the reader typed in the search drawer ('' clears): a new search under the next id, which ends the one running
   * in the page; with no query the page removes the hits it drew.
   */
  const askSearch = (raw: string) => {
    const next = searchStart(searchRef.current, raw)
    setSearch(next)
    call('search', [next.query || null, next.id])
  }
  /** The popups' close; `selectionDone`: the page's selection goes too, and the toolbar if it is still what is open. */
  const closePopup = (selectionDone: boolean) => {
    if (!selectionDone) return setPopup(null)
    call('clearSelection')
    if (popupRef.current?.kind === 'selection') setPopup(null)
  }
  /**
   * A `store` from the page (readStore's): the dev route keeps it in localStorage; the production route returns the
   * payload for the synced book (a store for another book is a previous open's, dropped).
   */
  const storeFor = (m: { key: string; json: string } | null) => {
    if (!m) return undefined
    if (dev) return void writeItem(storeKey(m.key), m.json)
    return sync.current && m.key === sync.current.target.sha256 ? m.json : undefined
  }
  const flushOpen = () => {
    const o = opening.current
    if (!ready.current || !o?.bytes) return
    openedBytes.current = o.bytes.byteLength
    deadlines.waitOpened(o.bytes.byteLength)
    // The server's format for the file (a clip is 'html', which the page never guesses from bytes); none: the page sniffs.
    call('openBytes', [o.bytes, o.name, o.sync?.format ?? null], [o.bytes])
    o.bytes = undefined
  }

  useEffect(() => {
    // The same object again (a re-render, StrictMode's second run) is not a new open: its bytes may be gone.
    if (!book || book === lastBook.current) return
    lastBook.current = book
    endSession(sessions.open(Date.now()))
    // Nothing of the previous book may stay on screen beside this one's answer (or its error).
    setError(null)
    setStopped(false)
    setOffer(null)
    setHeading(t('v2Reader.opening', { name: book.name }))
    setStatus('')
    setTocIndex(null)
    setTocOpen(false)
    // The previous book's search ends with it: its hits go from the page (still showing that book if this open fails).
    setSearchOpen(false)
    setSearchBook((n) => n + 1)
    if (searchRef.current.query) call('search', [null])
    setSearch(searchReset(searchRef.current))
    setPopup(null)
    setRestored('')
    setAtEnd(false)
    // #1316 review: nothing of the previous book's Discuss outlives the start of an open (the guard already holds
    // the new one): its chapter end, the server book its share would name, its shares and operation ids.
    setChapterEnd(null)
    setDiscussBook(null)
    setDiscussStates({})
    discuss.reset()
    discussLocks.reset()
    setHighlightList([])
    setBookmarks(null)
    openedSha.current = null
    pendingHighlight.current = highlightId ?? null
    // The previous book's session stays until `takeOpened`: no Finish block (and no click finishing that book)
    // from a relocate of it still on its way.
    setFinish(null)
    // The opening state is the top bar's title: shown, and kept up until `opened`.
    setReading(false)
    showBars()
    opening.current = { name: `${++opens.current}/${book.name}`, originalName: book.name, bytes: book.bytes, sync: book.sync }
    tracker.open(opening.current.name, opening.current)
    flushOpen()
  }, [book])

  useEffect(() => {
    deadlines.waitReady(readyDeadlineMs)
    return () => deadlines.dispose()
  }, [frameLoad])

  /** Retry after a deadline: a fresh frame; an open whose bytes the old one took is asked for again (`onReload`). */
  const reloadFrame = () => {
    ready.current = false
    setStopped(false)
    // #1265: the old frame's lightbox went with it, unannounced.
    setLightbox(false)
    // A fresh frame has no book on screen.
    setReading(false)
    setAtEnd(false)
    setChapterEnd(null)
    setPopup(null)
    showBars()
    const o = opening.current
    if (o && !o.bytes) {
      opening.current = null
      setHeading(null)
      setStatus('')
      onReloadRef.current?.()
    }
    setFrameLoad((n) => n + 1)
  }

  useEffect(() => {
    /** The page's book is `take.open`'s (openTracker.mjs: the open in flight, or a book the page kept on screen). */
    const takeOpened = ({ open: current, opened: m }: Take<Opening, HostOpenedMessage>) => {
      opening.current = current
      // The previous take's last writes go out; a later open of the same book reads after them (readerSync), another never waits.
      flushDraft()
      void sync.current?.close()
      sync.current = null
      retryRead.current = null
      setSaveStatus('saved')
      setHighlightsReady(false)
      setReadFailed(false)
      // Not `atEnd`: cleared where the open started; this book's first relocate (its end, for a book one screen
      // long) comes before its `opened` and must stand.
      setFinish(null)
      // The previous book's list goes; this one's comes with its `restored`.
      openedSha.current = m.book.sha256
      setHighlightList([])
      setBookmarks(null)
      setBookmarkable(m.bookmarkable === true)
      devNotes.current = new Map()
      const target = current.sync
      // Bytes that are not the server file's record no session either (below: nothing of that book's is saved).
      endSession(sessions.bind(!dev && target && target.sha256.toLowerCase() === m.book.sha256 ? target.bookId : null, Date.now()))
      // A language that does not read (`deu`) saves nothing: the fallback `en` would file its words under English cards.
      setVocabBook(!dev && target && target.sha256.toLowerCase() === m.book.sha256 && savesWords(m) ? { id: target.bookId, title: m.title || current.originalName } : null)
      // #1316: a chapter is shared only from the server's own file (its text is what the share says it is).
      setDiscussBook(!dev && target && target.sha256.toLowerCase() === m.book.sha256
        ? { bookId: target.bookId, fileId: target.fileId, title: m.title || current.originalName, author: typeof m.author === 'string' && m.author ? m.author : null, language: readLang(m) }
        : null)
      setDiscussStates({})
      discuss.reset()
      discussLocks.reset()
      if (dev) call('restore', [readItem(storeKey(m.book.sha256))])
      else if (!target) call('restore', [null])
      else if (target.sha256.toLowerCase() !== m.book.sha256) {
        // Bytes that are not the server file's: nothing of that book's data is theirs, and nothing is saved.
        console.warn(`[v2] opened bytes ${m.book.sha256} are not file ${target.fileId}: not synced`)
        setSaveStatus('unsaved')
        call('restore', [null])
      } else {
        const s = createReaderSync(target, {
          onStatus: setSaveStatus,
          // Drawn without moving the reader; highlighting is offered from now on.
          onHighlights: (list) => {
            setHighlightsReady(true)
            // Always, an empty list too (#1314): the page was told more annotations follow the restore, and makes no
            // bookmark until this call has placed them (its `bookmark-list` then says `can`).
            call('addHighlights', [list])
          },
          // #1350: a page-based book (PDF, CBZ) takes no highlights but bookmarks: its annotations are pulled too.
          highlights: m.annotatable !== false || m.bookmarkable === true,
          bookmarksOnly: m.annotatable === false,
          // A later offer replaces the one shown (the newest place).
          onNewerPlace: setOffer,
          // Every server state the session takes: a reset elsewhere brings the button back.
          onCompleted: (completedAt) => {
            if (sync.current === s) setFinish((f) => (f?.completedAt === completedAt ? f : { format: target.format, completedAt }))
          },
        })
        sync.current = s
        // Only while this take is the open one: a later take closed `s`, and its answers are none of this book's.
        const read = () => {
          setReadFailed(false)
          s.restore().then((json) => {
            if (sync.current !== s || json === null) return
            // `true`: the book's annotations follow by `addHighlights` (#1314: no bookmark before them).
            call('restore', [json, true])
            void s.loadHighlights()
          }, (e: unknown) => {
            console.warn('[v2] reading state not read:', e)
            if (sync.current === s) setReadFailed(true)
          })
        }
        retryRead.current = read
        read()
        // #1426: a book uploaded before the page read files gets its details, once; ADR-033 P3: a file the server has
        // no TOC for gets the page's. Beside the open, never in its way; one `describe` serves both.
        if (authenticated.current && navigator.onLine) {
          let details: Promise<FileDetails | null> | null = null
          const describe = () => (details ??= describeOpen(current))
          void fillBookMeta(m.book.sha256, describe)
          void syncTocIfMissing(target.bookId, target.fileId, async () => (await describe())?.toc, target.hasToc)
        }
      }
      setAnnotatable(m.annotatable !== false)
      setReflowable(m.reflowable !== false)
      setSearch(searchOpened(searchRef.current, m))
      // Untrusted: only what readToc takes. Its place came with the relocate before this message.
      const entries = readToc(m)
      setToc(entries)
      if (contentsOnOpen.current && entries.length) {
        setTocOpen(true)
        onContentsShownRef.current?.()
      }
      // #1557: a PDF's contents come after `opened`, as `toc`: the request waits for them.
      if (m.format !== 'pdf' || entries.length) contentsOnOpen.current = false
      setBookLanguage(readLang(m) ?? 'en')
      setMarksLanguage(savesWords(m) ? readLang(m) ?? 'en' : null)
      setTtsLanguage(ttsLang(m.lang, 'en'))
      setPopup(null)
      setReading(true)
      // Untrusted (the page renders the book): only what readDir takes; none is left to right.
      pageDir.current = readDir(m) ?? 'ltr'
      setHeading([m.title || current.originalName, m.author].filter(Boolean).join(' — '))
      onOpenedRef.current?.(m, current.originalName)
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== location.origin || typeof e.data !== 'string') return
      let m: any
      try { m = JSON.parse(e.data) } catch { return }
      // No book on screen (loading, opening, a fresh frame): a tap, key, word or selection does nothing.
      if (!readingRef.current && !takenWithoutBook(m?.type)) return
      switch (m?.type) {
        case 'ready':
          deadlines.ready()
          // A fresh frame shows no image.
          setLightbox(false)
          // The stored layout before the first open: messages arrive in order, and a setting is not a switch.
          call('flow', [flowRef.current])
          call('settings', [settingsRef.current])
          // #1267: the lightbox's words in the reader's language (README, `labels`): the page has no i18n.
          call('labels', [{ image: tRef.current('v2Reader.lightboxImage'), close: tRef.current('v2Reader.lightboxClose') }])
          ready.current = true
          // A fresh frame holds no words: sent only when there are some.
          if (marks.current.words.length) sendMarks()
          flushOpen()
          return
        case 'opened': {
          const take = tracker.opened(m)
          if (!take) return
          deadlines.answered()
          takeOpened(take)
          return
        }
        case 'book-stopped':
          // #1204: only for the book on screen; Retry (a fresh frame) opens it again.
          if (isBookKey(m?.key, openedSha.current)) setStopped(true)
          return
        case 'toc': {
          // #1557: a PDF's outline, after its `opened`. Untrusted: only what readTocMessage takes, for the book on screen.
          const u = readTocMessage(m, openedSha.current)
          if (!u) return
          setToc(u.toc)
          setTocIndex(u.tocIndex)
          // `openContents` for a PDF (#1557): its contents are here now.
          if (contentsOnOpen.current && u.toc.length) {
            setTocOpen(true)
            onContentsShownRef.current?.()
          }
          contentsOnOpen.current = false
          return
        }
        case 'open-failed': {
          const f = tracker.failed(m.name)
          if (!f) return
          deadlines.answered()
          // Not the title of the book before it (#1168, #1080 item 6): the alert names the file.
          setHeading('')
          setError(t('v2Reader.cannotOpen', { name: f.failed.originalName, error: String(m.error) }))
          // The old book may still post a relocate until the page takes up this open (bytes read +
          // messages in flight); a failure must not leave it standing after the open cleared it (#1168).
          setStatus('')
          opening.current = null
          // The page kept a book on screen that answered meanwhile: it is the one read now.
          if (f.take) takeOpened(f.take)
          return
        }
        case 'highlights':
          // addHighlights' answer: one not drawn is the server's but not where its text is in this file.
          for (const h of m.highlights ?? []) if (h.status !== 'restored' && h.status !== 'listed') console.warn(`[v2] highlight ${h.id} not drawn: ${h.status}`)
          return
        case 'highlight-list': {
          // Untrusted: only what readHighlightList takes; another book's (a previous open's) is dropped.
          const l = readHighlightList(m)
          if (!l || l.key !== openedSha.current) return
          setHighlightList(l.highlights)
          // By the id the server holds (a page id re-keyed this open is still the old one on the page).
          const want = pendingHighlight.current && l.highlights.find((h) => (sync.current?.real(h.id) ?? h.id) === pendingHighlight.current)
          if (want) {
            pendingHighlight.current = null
            // The reader's own choice (they followed the link): saved where it lands (README, `goTo`). #1195: a
            // quotation has no place: the link is done with, nothing moves.
            if (!want.quotation) hostMove('goTo', [want.cfi, true])
            onHighlightShownRef.current?.()
          }
          return
        }
        case 'bookmark-list': {
          // #1314, untrusted: only what readBookmarkList takes; another book's (a previous open's) is dropped. Without
          // its list (#1354: unchanged) the one held is kept.
          const sha = openedSha.current
          setBookmarks((prev) => readBookmarkList(m, { open: sha, prev }) ?? prev)
          return
        }
        case 'highlight-tap': {
          // A tap on a drawn highlight: its editor where the toolbar would be (popupStep: an edge still turns).
          // Where no highlight is offered yet (the server's not in), a tap like any other.
          const h = readHighlightTap(m)
          if (h) onPopupEvent(offersRef.current ? { type: 'highlight', highlight: h } : { type: 'tap', x: h.x })
          return
        }
        case 'highlight-removed': {
          // The page removed it (its editor's Delete): a tombstone on the server, for the synced book only.
          const r = readHighlightRemoved(m)
          if (!r || r.key !== openedSha.current) return
          if (dev) devNotes.current.delete(r.id)
          else if (sync.current?.target.sha256.toLowerCase() === r.key) sync.current.remove(r.id)
          return
        }
        case 'search-results': {
          // #1315, untrusted: only what readSearchResults takes; another book's or an older search's is dropped.
          const r = readSearchResults(m)
          if (!r || r.key !== openedSha.current) return
          searchRef.current = searchTake(searchRef.current, r)
          renderSearch(searchRef.current.done)
          return
        }
        case 'described': {
          const d = readDescribed(m)
          if (d) described.current.get(d.id)?.(d.meta ? d : null)
          return
        }
        case 'restored':
          // Only for the book taken last: a stale answer must not show another book as restored.
          if (!tracker.restored(m)) return
          setRestored(t('v2Reader.restore', { state: String(m.position) }))
          return
        case 'store': {
          // Keyed on the route: the production route never keeps reader data in this browser (the server only).
          const json = storeFor(readStore(m))
          if (json !== undefined) sync.current?.store(json)
          return
        }
        case 'relocate': {
          // Untrusted (the page renders the book): the chrome reads only what readRelocate takes.
          const r = readRelocate(m)
          if (!r) return
          pageDir.current = r.dir ?? pageDir.current
          // The reader moved the place: a word popup's word left it (the toolbar follows the page's selection messages).
          if (r.moved) onPopupEvent({ type: 'moved' })
          const msSinceHostMove = hostMoves.onRelocate(Date.now())
          if (readingRef.current && hidesBarsOnRelocate({ moved: r.moved, msSinceHostMove })) hideBars()
          // Not after a failed open, until the next open (openTracker.mjs showsPosition: the rule and its cost).
          if (!tracker.showsPosition()) return
          sessions.relocate(r, Date.now())
          setTocIndex(r.tocIndex)
          setTimePlace({ fraction: r.fraction, sectionEnd: r.sectionEnd, words: r.words })
          setStatus(percentText(r.fraction))
          setAtEnd(r.atEnd)
          // Untrusted, as the rest: only what readChapterEnd takes.
          setChapterEnd(readChapterEnd(m))
          return
        }
        case 'chapter-end':
          // #1316: the chapter end of the place last reported, known only now. Not after a failed open, as its relocate.
          if (tracker.showsPosition()) setChapterEnd(readChapterEnd(m))
          return
        case 'chapter-text': {
          // #1316: the page's answer to this host's own request (an id it made); anything else is dropped.
          discuss.answer(readChapterText(m))
          return
        }
        case 'tap': {
          // A press that dismissed a selection sends no `tap`, a link none either. Untrusted: only what readTap
          // takes. Page-viewport px = this frame's.
          const p = readTap(m)
          if (!p) return
          sessions.activity(Date.now())
          onPopupEvent({ type: 'tap', x: p.x })
          return
        }
        case 'word': {
          // #1269: an edge word in paginated flow turns the page, any other opens its popup (popupStep). Untrusted:
          // only what readWord takes.
          const w = readWord(m)
          if (!w) return
          sessions.activity(Date.now())
          // Dev stub: the label proves the word → showTranslation round trip (no CFI: none).
          if (dev && w.cfi) call('showTranslation', [w.cfi, w.index, `dev: ${w.word}`])
          onPopupEvent({ type: 'word', word: w })
          return
        }
        case 'key': {
          // A key pressed in the page (its frames keep focus): only what readKey takes.
          const k = readKey(m)
          if (k) sessions.activity(Date.now())
          onNavKey(k)
          return
        }
        case 'selection': {
          // Untrusted (the page renders the book): only what readSelection takes; a malformed one is dropped.
          const s = readSelection(m)
          if (!s) return
          sessions.activity(Date.now())
          onPopupEvent({ type: 'selection', selection: s })
          return
        }
        case 'selection-cleared':
          onPopupEvent({ type: 'selection-cleared' })
          return
        case 'lightbox': {
          // #1265: an image tapped in the page (never a `tap` or `word`): what was open closes, the bars hide while it shows.
          const shown = readLightbox(m)
          if (shown === null) return
          setLightbox(shown)
          if (shown) {
            setPopup(null)
            hideBars()
          }
          return
        }
        case 'pointer-move':
          // The mouse moved over the book (the page's, throttled; no payload): the bars' mouse path.
          onMouseMove()
          return
        case 'openLink':
          if (/^https?:\/\//i.test(m.href)) window.open(m.href, '_blank', 'noopener,noreferrer')
          return
        case 'telemetry':
          // Logged only; the event is defined by the page (README, telemetry).
          console.log('[v2] telemetry', JSON.stringify(m))
          return
        case 'log':
          console.log(`[v2 page] ${m.level}: ${m.msg}`)
      }
    }
    addEventListener('message', onMessage)
    // Online-first: what did not land is written again when the tab is hidden, and by a keepalive write as it goes.
    // A hidden tab ends the reading session too (the legacy reader's rule); the next activity starts another.
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return
      flushDraft(true)
      void sync.current?.flush()
      endSession(sessions.end(Date.now()))
    }
    // The page's last turn (#1286): its own pagehide `store` would reach a document that is unloading; taken here first.
    const onPageHide = () => {
      const last = storeFor(pageLastStore(frame.current))
      // The open editor's changed note goes with the keepalive writes (the session's notes are sent by them).
      flushDraft(true)
      sync.current?.flushKeepalive(last)
      // Queued synchronously (localStorage); a send cut by the unload goes at the next reader's flush.
      endSession(sessions.end(Date.now()))
    }
    document.addEventListener('visibilitychange', onVisibility)
    addEventListener('pagehide', onPageHide)
    return () => {
      removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onVisibility)
      removeEventListener('pagehide', onPageHide)
      // Leaving the route (SPA navigation): the session's last pass still writes what is unsaved.
      flushDraft()
      void sync.current?.close()
      sync.current = null
      endSession(sessions.end(Date.now()))
    }
  }, [])

  // The reading session's heartbeat (5 min idle ends it), and what earlier visits left queued (#1313).
  useEffect(() => {
    if (!dev) void flushPendingSessions()
    const id = setInterval(() => endSession(sessions.tick(Date.now())), SESSION_HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [])

  // Leaving the route (#1286): the page's last turn, taken while the frame is still in the document (a layout
  // cleanup runs before React removes it; the passive one below it, after). The session's close joins it.
  useLayoutEffect(() => () => {
    const last = storeFor(pageLastStore(frame.current))
    // Before the close: the session's last pass writes the editor's changed note too.
    flushDraft()
    void sync.current?.close(last)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (onNavKey(hostNavKey(e), e.target instanceof Element && !!e.target.closest('.word-popup'))) e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  /** The bottom bar's height: the Finish book block sits just above it. */
  const [footerHeight, setFooterHeight] = useState(0)
  useEffect(() => {
    const f = footer.current
    if (!f || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setFooterHeight(f.offsetHeight))
    ro.observe(f)
    return () => ro.disconnect()
  }, [])

  // Hidden bars keep no focus: an invisible control must not be activated by a key.
  useEffect(() => {
    const at = document.activeElement
    if (barsHidden && at && (header.current?.contains(at) || footer.current?.contains(at))) main.current?.focus({ preventScroll: true })
  }, [barsHidden])

  /**
   * #1316: the chapter's text, read by the page, is shared with the reader's account, then the chat can open with
   * the share's id. Guarded by the identity it started under (this open, this account's store epoch): once either
   * changed, nothing is sent and nothing is shown. One share at a time per chapter.
   */
  const discussChapter = (chapter: ChapterEnd, title: string | null) => {
    const book = discussBook
    const open = opening.current
    const epoch = syncStore.epoch
    const asker = account.current
    const key = chapterKey(chapter)
    if (!book || !open) return
    // One run per chapter, taken at once: two clicks in one tick make one share.
    const release = discussLocks.take(key)
    if (!release) return
    const current = () => opening.current === open && syncStore.epoch === epoch && account.current === asker
    const set = (state: DiscussState | undefined) => {
      if (!current()) return
      setDiscussStates((all) => {
        const { [key]: _, ...rest } = all
        return state ? { ...rest, [key]: state } : rest
      })
    }
    set({ phase: 'sharing' })
    void runDiscuss({
      canConnect: !isGuest,
      grants: listOAuthGrants,
      serverBook: async () => ({ bookId: book.bookId, fileId: book.fileId }),
      share: (server) => discuss.discuss(
        { ...chapter, ...server, chapterKey: key, chapterTitle: title, bookTitle: book.title, author: book.author, language: book.language },
        current,
      ),
      current,
    }).then((state) => {
      if (state?.phase === 'failed') console.warn('[v2] chapter not shared:', state.reason)
      set(state)
    }).finally(release)
  }
  /** The connect dialog closed (or anything else the reader dismisses): the chapter's block is idle again. */
  const dismissDiscuss = (key: string) => setDiscussStates(({ [key]: _, ...rest }) => rest)
  // #1316 review: another account (or none): a share in flight under the previous one shows nothing and holds
  // nothing, so the block is usable at once without reopening the book.
  useEffect(() => {
    setDiscussStates({})
    discuss.reset()
    discussLocks.reset()
  }, [accountId])
  /** Discuss is offered for the chapter the page says ended (its title the page's too), by the hosts' one rule. */
  const discussEnd = discussBook && offersDiscuss(chapterEnd) ? chapterEnd : null
  const finishShown = !!finish && finish.completedAt !== undefined && showsFinishBook({ atEnd, format: finish.format })

  /** Finish book: through the open book's session; an answer for a book no longer the open one changes nothing. */
  const finishBook = async () => {
    const s = sync.current
    if (!s) throw new Error('no book to finish')
    const completedAt = await s.complete()
    if (sync.current === s) setFinish({ format: s.target.format, completedAt })
  }

  // Applied live: the page re-lays the book out where it is (README, `settings`).
  useEffect(() => {
    if (ready.current) call('settings', [settings])
  }, [settings])
  // #1271: the setting switched: the page draws or hides the glosses on screen at once.
  useEffect(() => {
    if (marks.current.show === glosses) return
    marks.current = { ...marks.current, show: glosses }
    sendMarks()
  }, [glosses])
  /**
   * A contents entry the reader chose (the dialog, the section controls). Chosen: the page saves where it lands
   * (README, `goTo`). It is the current one at once: a jump within the view on screen may send no relocate.
   */
  const goToc = (e: TocEntry) => {
    setTocIndex(e.index)
    hostMove('goTo', [e.href, true])
  }
  /** #1312: highlights are offered (the dev route always; the production route once the server's are in). */
  const offersHighlights = annotatable && (dev || highlightsReady)
  const offersRef = useRef(false)
  offersRef.current = offersHighlights
  const noteFor = (id: string) => (dev ? devNotes.current.get(id) ?? null : sync.current?.note(id) ?? null)
  const tapped = popup?.kind === 'highlight' ? highlightList.find((h) => h.id === popup.id) : undefined
  // #1312 review: tapped while the server holds it as deleted (a 409 `deleted`, another device): no editor; it leaves the page.
  const tappedDeleted = !!tapped && !dev && !!sync.current?.deleted(tapped.id)
  useEffect(() => {
    if (!tappedDeleted || !tapped) return
    call('removeHighlight', [tapped.id])
    setPopup(null)
  }, [tappedDeleted])
  const editor: HighlightEditor | null = tapped && offersHighlights && !tappedDeleted ? {
    item: tapped,
    note: noteFor(tapped.id),
    onRecolor: (color) => call('recolorHighlight', [tapped.id, color]),
    // Held here, with the session of the book it was opened in: written whatever closes the editor (Save included).
    // The baseline is the host's once set (a flush moves it); the session, the one the editor opened in.
    onDraft: (d) => {
      const was = editorDraft.current
      editorDraft.current = d && { text: d.text, from: was ? was.from : d.from, id: tapped.id, session: was?.session ?? sync.current }
    },
    onDelete: () => call('removeHighlight', [tapped.id]),
  } : null
  /** A highlight or a bookmark chosen in its list, or a search result (#1315): the reader's choice, saved where it lands. */
  const goHighlight = (h: { cfi: string }) => hostMove('goTo', [h.cfi, true])
  /**
   * #1314: bookmarks are the book's annotations, offered as highlights are (never before the server's are in: a write
   * would duplicate one). The button adds one at the place on screen, or removes the one there; the page answers a
   * removal with `highlight-removed`, the tombstone's path.
   */
  // #1350: on a page-based book too (no highlights: a PDF, a CBZ), once the server's annotations are in.
  const offersMarks = (annotatable || bookmarkable) && (dev || highlightsReady)
  const bookmarkHere = offersMarks && bookmarks ? bookmarks.here : null
  // Only for the book being read, where the book takes bookmarks (or holds some). Kept on the bars while the page says
  // none can be made now (bookmarks being placed, nothing to keep on this screen): disabled, so the bars never shift.
  const offersBookmark = reading && offersMarks && (bookmarkable || !!bookmarks?.bookmarks.length)
  const bookmarkEnabled = !!bookmarks && (bookmarks.can || !!bookmarks.here)
  const toggleBookmark = () => (bookmarkHere ? call('removeBookmark', [bookmarkHere]) : call('addBookmark'))
  /** The Bookmarks tab: where the book can take one, or holds some already. */
  const bookmarksTab = offersMarks && (bookmarkable || !!bookmarks?.bookmarks.length)
    ? { items: bookmarks?.bookmarks ?? [], can: !!bookmarks?.can, placing: !bookmarks || bookmarks.placing, onGo: goHighlight, onRemove: (id: string) => call('removeBookmark', [id]) }
    : null

  /** Never a section number (#1261): the percent, then the current entry's title when there is one. */
  const currentEntry = tocAround(toc, tocIndex).current
  const statusLine = status && currentEntry ? `${status} · ${currentEntry.label}` : status

  const toggleFlow = () => {
    const next: Flow = flow === 'paginated' ? 'scrolled' : 'paginated'
    setFlow(next)
    flowRef.current = next
    writeItem(FLOW_KEY, next)
    if (ready.current) call('flow', [next])
  }

  return (
    <main ref={main} tabIndex={-1} className={`reader-page v2-reader${barsHidden ? ' immersive-mode' : ''}`} data-bars={barsHidden ? 'hidden' : 'shown'} onMouseMove={onMouseMove}>
      {/* #1267: past the bars to the book (the legacy reader's skip link); the frame takes focus, its keys turn pages. */}
      <a href={`#${BOOK_ID}`} className="skip-link" inert={lightboxOpen} onClick={(e) => { e.preventDefault(); frame.current?.focus() }}>{t('v2Reader.skipToBook')}</a>
      {/* Legacy reader's bars (reader.css); hidden ones stay reachable by Tab, and focus shows them. */}
      <header ref={header} className="reader-top-bar" onFocus={showBars} inert={lightboxOpen}>
        <div className="reader-top-bar__left">
          {backUrl && (
            <Link to={backUrl} className="reader-top-bar__back" aria-label={t('v2Reader.back')}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
          )}
          <div className="reader-top-bar__title">
            <span className="reader-top-bar__book-title" data-testid="v2-heading">{heading ?? idleHeading}</span>
          </div>
        </div>
        <div className="reader-top-bar__right">
          {toolbar}
          {reading && (toc.length > 0 || offersHighlights || !!bookmarksTab) && <button className="reader-top-bar__btn" onClick={() => setTocOpen(true)}>{t('v2Reader.contents')}</button>}
          {reading && search.searchable && (
            <button className="reader-top-bar__btn" onClick={() => setSearchOpen(true)} aria-label={t('v2Reader.search')} title={t('v2Reader.search')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </button>
          )}
          {offersHighlights && <button className="reader-top-bar__btn" onClick={() => call('highlightSelection')}>{t('v2Reader.highlight')}</button>}
          {offersBookmark && (
            // One name, its state in aria-pressed (#1314 review): a toggle's label never changes with its state.
            <button className="reader-top-bar__btn" data-testid="v2-bookmark" aria-pressed={!!bookmarkHere} aria-label={t('reader.chrome.bookmark')} title={t('reader.chrome.bookmark')} disabled={!bookmarkEnabled} onClick={toggleBookmark}>
              {/* Filled while a bookmark is on screen. */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill={bookmarkHere ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
              </svg>
            </button>
          )}
          <button className="reader-top-bar__btn" onClick={toggleFlow} disabled={!reflowable}>{flow === 'paginated' ? t('v2Reader.scrolled') : t('v2Reader.paginated')}</button>
          <button className="reader-top-bar__btn" onClick={() => setSettingsOpen(true)} aria-label={t('v2Reader.settings')} title={t('v2Reader.settings')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
              <circle cx="8" cy="6" r="2" fill="currentColor" />
              <circle cx="16" cy="12" r="2" fill="currentColor" />
              <circle cx="10" cy="18" r="2" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>
      {/* The states: in layout above the frame (never over the book), never hidden with the bars. */}
      {/* Never inert as a whole (#1267 review): its status and alert regions are still announced with an image open;
          only its buttons are, so Tab out of the lightbox never lands on them. The route's `children` (a load error)
          show only before a book is on screen, when no lightbox can be. */}
      <div className="v2-reader__notices">
        {saveStatus !== 'saved' && (
          <span role="status" data-testid="v2-not-saved">{t(SAVE_MESSAGE[saveStatus])}</span>
        )}
        {offer && (
          <div role="status" aria-label={t('v2Reader.newerPlaceLabel')} data-testid="v2-newer-place">
            {t('v2Reader.newerPlace', { percent: Math.round((offer.fraction ?? 0) * 100) })}{' '}
            <button inert={lightboxOpen} onClick={() => setOffer(null)}>{t('v2Reader.stayHere')}</button>{' '}
            {/* Chosen: the page saves where it lands (README, `goTo`). */}
            <button inert={lightboxOpen} onClick={() => { hostMove('goTo', [offer, true]); setOffer(null) }}>{t('v2Reader.goThere')}</button>
          </div>
        )}
        {readFailed && (
          <span role="alert" data-testid="v2-read-failed">
            {t('v2Reader.readFailed')} <button inert={lightboxOpen} onClick={() => retryRead.current?.()}>{t('v2Reader.retry')}</button>
          </span>
        )}
        {dev && <span data-testid="v2-restore">{restored}</span>}
        {overdue && (
          <span role="alert" data-testid="v2-overdue">
            {overdue === 'ready'
              ? (dev ? t('v2Reader.frameFailedDev', { path: FRAME_SRC, seconds: readyDeadlineMs / 1000 }) : t('v2Reader.frameFailed', { seconds: readyDeadlineMs / 1000 }))
              : t('v2Reader.openTimeout', { name: opening.current?.originalName ?? '', seconds: Math.ceil(openedDeadlineMs(openedBytes.current) / 1000) })}{' '}
            <button inert={lightboxOpen} onClick={reloadFrame}>{t('v2Reader.retry')}</button>
          </span>
        )}
        {stopped && (
          <span role="alert" data-testid="v2-stopped">
            {t('v2Reader.bookStopped', { name: opening.current?.originalName ?? '' })}{' '}
            <button inert={lightboxOpen} onClick={reloadFrame}>{t('v2Reader.retry')}</button>
          </span>
        )}
        {error && <span role="alert">{error}</span>}
        {children}
      </div>
      {/* allow-same-origin is required: foliate reads its section frames' documents, and under an opaque
          origin every nested frame gets its own. So the page shares the app's origin, and the page CSP is the
          only script barrier (README "Sandbox"). A book script past it would reach this origin's localStorage
          AND its /api session cookie. The shell itself is public (it carries no data, nginx serves it to
          anyone); what is gated is the route that hands it a book: the reader's own `/me/v2` session.
          A second origin: docs/internal/v2/v2-reader-web-hosting.md. */}
      {/* Sibling keys are namespaced: frameLoad and searchBook both start at 0 (#1586). */}
      <iframe key={`frame-${frameLoad}`} ref={frame} id={BOOK_ID} title={t('v2Reader.frameTitle')} sandbox="allow-scripts allow-same-origin" src={FRAME_SRC} className="v2-reader__frame" />
      {/* #1385: touch, bars hidden (moved off screen): a tap where a bar was shows the bars instead of reaching the
          book, where it would turn the page. Desktop needs none: a mouse move shows them. */}
      {barsHidden && !mouse && reading && !lightboxOpen && (
        <>
          <div className="v2-reader__reveal v2-reader__reveal--top" data-testid="v2-reveal-top" aria-hidden="true" onClick={showBars} />
          <div className="v2-reader__reveal v2-reader__reveal--bottom" data-testid="v2-reveal-bottom" aria-hidden="true" onClick={showBars} />
        </>
      )}
      <footer ref={footer} className="reader-footer" onFocus={showBars} inert={lightboxOpen}>
        {reading && <SectionNav toc={toc} tocIndex={tocIndex} onGo={goToc} />}
        <div className="reader-footer__info v2-reader__footer">
          <button className="reader-top-bar__btn" onClick={() => hostMove('prev')}>{t('v2Reader.prev')}</button>
          <span className="reader-footer__counter" data-testid="v2-status">{statusLine}</span>
          {status && timePlace && <TimeLeft {...timePlace} />}
          <button className="reader-top-bar__btn" onClick={() => hostMove('next')}>{t('v2Reader.next')}</button>
        </div>
      </footer>
      {/* Over the frame, above the bottom bar (or the screen's edge with the bars hidden), out of flow: showing it
          must never resize the frame, or foliate re-lays out, `atEnd` turns false, the block hides, and it loops. */}
      {(finishShown || discussEnd) && (
        // Hidden and inert under the lightbox (#1267 review), kept mounted: a write in flight or its failure stays.
        <div className="v2-reader__finish" data-testid="v2-finish-block" inert={lightboxOpen} style={{ '--v2-finish-above': `${barsHidden ? 0 : footerHeight}px`, visibility: lightboxOpen ? 'hidden' : undefined } as CSSProperties}>
          {discussEnd && (
            <ChapterDiscuss key={chapterKey(discussEnd)} title={discussEnd.title} state={discussStates[chapterKey(discussEnd)]} onShare={() => discussChapter(discussEnd, discussEnd.title)} onDismiss={() => dismissDiscuss(chapterKey(discussEnd))} />
          )}
          {finishShown && finish && <FinishBook finished={!!finish.completedAt} onFinish={finishBook} />}
        </div>
      )}
      {reading && (
        // Keyed: the legacy translation hooks take their languages once, at mount.
        <ReaderPopups
          key={bookLanguage}
          popup={popup}
          frame={frame}
          bookLanguage={bookLanguage}
          marksLanguage={marksLanguage}
          bookId={vocabBook?.id}
          bookTitle={vocabBook?.title}
          onHighlight={offersHighlights ? (color) => call('highlightSelection', [color]) : undefined}
          highlight={editor}
          onMarks={(words) => {
            // None over none changes nothing on the page.
            if (!words.length && !marks.current.words.length) return
            marks.current = { ...marks.current, words }
            sendMarks()
          }}
          onClose={closePopup}
          lang={ttsLanguage}
          ttsSpeed={ttsSpeed}
          onSpoken={(r) => call('speaking', r ? [r.cfi, r.index] : [null])}
        />
      )}
      <ReaderSettingsDrawer open={settingsOpen} settings={settings} onUpdate={updateSettings} onClose={() => setSettingsOpen(false)} typography={reflowable} ttsSpeed={ttsSpeed} onTtsSpeed={updateTtsSpeed}
        glosses={annotatable ? { on: glosses, onChange: setGlosses } : undefined} />
      <TocDrawer
        open={tocOpen && reading}
        toc={toc}
        tocIndex={tocIndex}
        onGo={goToc}
        onClose={() => setTocOpen(false)}
        highlights={offersHighlights ? { items: highlightList, noteOf: noteFor, onGo: goHighlight } : null}
        bookmarks={bookmarksTab}
      />
      {/* Opened only from its button (a searchable book on screen); a new open closes it. */}
      <SearchDrawer key={`search-${searchBook}`} open={searchOpen} search={search} onQuery={askSearch} onGo={goHighlight} onClose={() => setSearchOpen(false)} />
    </main>
  )
}
