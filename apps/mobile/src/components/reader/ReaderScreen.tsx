import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { AppState, BackHandler, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { uuid } from 'expo-modules-core'
import { MAX_VOCABULARY_TEXT, bookTitle as titleOf, fillBookMeta, FALLBACK_WPM, OPENED_AT_KEY, withOpened, chooseChat, createDiscussLocks, createDiscuss, handoffUrl, oauthGrantsApi, placeTimeLeftLabel, runDiscuss, timeLeftAt, syncApi, ttsHasVoice, type PagePosition, type ClientFormat, type DiscussShared, type DiscussState, type FileDetails } from '@textstack/shared'
import { loadReviewAssistant } from '../../lib/chapterReviewLaunch'
import { useTheme } from '../../context/ThemeContext'
import { useAuth } from '../../context/AuthContext'
import { deviceUploadIo, resetSince, uploadBook } from '../../lib/sync'
import { downloadIo, hostFile } from '../../lib/reader/deviceDownload'
import { bookFile, createHostStorage, nonceFromUuid, sha256Key, type LibraryBook, type HostFiles, type HostStorage } from '../../lib/reader/hostStorage'
import { deviceLocalLibrary, makeFileDirs, sweepStaging } from '../../lib/reader/deviceLibrary'
import { capabilitiesFor } from '../../lib/capabilities'
import type { BookNotes, BookRow } from '../../lib/reader/localLibrary'
import { downloadBook, openBookHost, syncLibrary, tryAgainBook, type SyncHost } from '../../lib/reader/sync'
import { DESCRIBE_MS, PAGE_WEBVIEW_PROPS, pageSource } from './pageWebView'
import { createOpenTracker, type Take } from '../../../../../packages/reader/src/openTracker.mjs'
import { createMovedTracker } from '../../../../../packages/reader/src/movedTracker.mjs'
import { createSessionTracker, SESSION_HEARTBEAT_MS, type EndedSession } from '../../../../../packages/reader/src/sessionTracker.mjs'
import { createDeadlines, createOverdueStrikes, READY_DEADLINE_MS, type Overdue } from '../../../../../packages/reader/src/deadlines.mjs'
import { hostError } from '../../lib/reader/hostErrors'
import { holdOpenSession } from '../../lib/reader/openSession'
import { syncOpenedToc } from '../../lib/reader/openedToc'
import { fill } from '../../lib/fill'
import { readSelection } from '../../../../../packages/reader/src/selection.mjs'
import { createScrollIntent, readReaderScroll } from '../../../../../packages/reader/src/scrollChrome.mjs'
import { readDescribed } from '../../../../../packages/reader/src/describe.mjs'
import NetInfo from '@react-native-community/netinfo'
import {
  BOOK_CLOSED, CLOSE_BOOK_JS, backAction, createHostMoves, hidesBarsOnRelocate, keyAction, readDir, readKey, readLightbox, readRelocate, readTap,
  reopensOnReady, takenWithoutBook,
} from '../../../../../packages/reader/src/chrome.mjs'
import { showsFinishBook } from '../../../../../packages/reader/src/finishBook.mjs'
import { FinishBook } from './FinishBook'
import { ChapterDiscuss } from './ChapterDiscuss'
import { chapterKey, offersDiscuss, readChapterEnd, readChapterText, type ChapterEnd } from '../../../../../packages/reader/src/chapters.mjs'
import { useAssistantLauncher } from '../../hooks/useAssistantLauncher'
import { ConnectAssistantSheet } from '../library/ConnectAssistantSheet'
import { popupStep, readLang, readWord, type Popup, type PopupEvent } from '../../../../../packages/reader/src/wordPopup.mjs'
import { readerTextLanguage } from '../../lib/bookLanguage'
import { saveOutcome, savesWords } from '../../../../../packages/reader/src/vocabSave.mjs'
import { vocabularyApi } from '../../lib/vocabularyApi'
import { fillSavedTranslation, saveWordWithRetry } from '../../lib/savedWord'
import { saveWordForBook } from '../../../../../packages/reader/src/wordBook'
import { vocabMapKey } from '../../lib/vocabMapKey'
import { backfillTranslations, markWordsOf } from '../../../../../packages/reader/src/vocabWords.mjs'
import { answerRow, backfillable, forBook, nudgeCount, ownsLibrary, serverTranslation, type ReaderWord } from '../../../../../packages/reader/src/readerVocab'
import type { WriteGuard } from '../../lib/reader/localLibrary'
import { syncOn } from '../../lib/sync'
import { cachedTranslate } from '../../lib/translateCache'
import { useReaderSettings } from '../../hooks/useReaderSettings'
import { saveWordIntent } from '../../lib/saveWordIntent'
import { claimGuestNudge } from '../../lib/guestNudge'
import { useToast } from '../../context/ToastContext'
import { useHaptics } from '../../hooks/useHaptics'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { SelectionActionBar } from '../SelectionActionBar'
import { HighlightNoteModal } from '../HighlightNoteModal'
import { colorOf, noteChange, readHighlightList, readHighlightRemoved, readHighlightTap, type HighlightColor, type HighlightItem } from '../../../../../packages/reader/src/highlights.mjs'
import { TranslationSheet } from '../TranslationSheet'
import { ExplanationSheet } from '../ExplanationSheet'
import { readBookmarkList, type BookmarkList } from '../../../../../packages/reader/src/bookmarks.mjs'
import { readToc, tocAround, type TocEntry } from '../../../../../packages/reader/src/toc.mjs'
import { BookmarksSheet, HighlightsSheet, SectionNav, TocSheet } from './ReaderToc'
import { SearchSheet } from './SearchSheet'
import { NO_SEARCH, createSearchRenders, readSearchResults, searchOpened, searchReset, searchStart, searchTake, type Search } from '../../../../../packages/reader/src/search.mjs'
import { bookUrl } from '../../../../../packages/reader/src/bookOrigin.mjs'
import { useLanguage } from '../../context/LanguageContext'
import { openPlayStorePage } from '../../lib/playStore'
import { USER_AGENT_PROBE, createWebViewCheck, webViewStorePackage, type WebViewVerdict } from '../../lib/reader/webViewVersion'
import { useReaderBars } from '../../hooks/useReaderBars'
import { useKeepReaderAwake } from '../../hooks/useKeepReaderAwake'
import { useFlushOnLeave } from '../../hooks/useFlushOnLeave'
import { ReaderTopBar } from '../reader/ReaderTopBar'
import { ReaderFooter } from '../reader/ReaderFooter'
import { THEMES, readSettings } from '../../../../../packages/reader/src/settings.mjs'
import { SettingsSheet, storedPageSettings, usePageSettings, useTtsSpeed } from './SettingsSheet'
import { useTts } from '../../hooks/useTts'
import { createListener, speakingJs, spokenOf, ttsLang } from '../../../../../packages/reader/src/listen.mjs'

/**
 * The V2 reader (ADR-029) on Android: the reader route `app/my-books/read/[bookId]/…`, and
 * the dev route `app/dev/epub.tsx` (dev builds only, with its library list).
 * Hosts the generated page and drives the contract in src/lib/reader/README.md:
 * ready → openUrl → opened → restore → restored, then store / relocate / word / openLink.
 */

function deviceFiles(): HostFiles {
  // Anything an earlier process staged and never finished; this process's own (a Download, an upload) stay (#1526).
  sweepStaging()
  makeFileDirs()
  return {
    read: async (name) => {
      const file = hostFile(name)
      return file.exists ? file.text() : null
    },
    move: (from, to) => hostFile(from).move(hostFile(to), { overwrite: true }),
    exists: (name) => hostFile(name).exists,
    remove: (name) => {
      const file = hostFile(name)
      if (file.exists) file.delete()
    },
    // expo-file-system copies a SAF/content:// source to a local file (Android, since 56.0.0).
    copyIn: (uri, to) => new File(uri).copy(hostFile(to)),
  }
}

// One storage for the process, so every read and write goes through its one queue.
let storage: HostStorage | null = null
const readerStorage = () => (storage ??= createHostStorage(deviceFiles(), uuid.v4, deviceLocalLibrary(), resetSince))

/**
 * File sync (opt-in): the retained copy's bytes through the shared upload sequence, with the format
 * the page reported (the retained name always ends `.epub`) and to the book's KNOWN server ids only.
 */
const uploadRetained: SyncHost['upload'] = async (b: BookRow, maxPartBytes, cancelled) => {
  await uploadBook(
    { uri: hostFile(bookFile(b.sha256!)).uri, name: b.original_name, format: (b.format ?? undefined) as ClientFormat | undefined },
    maxPartBytes,
    deviceUploadIo(cancelled),
    undefined,
    { bookId: b.id, fileId: b.server_file_id!, sha256: b.sha256! },
  )
}

/** A sync pass is asked for this long after the last save (the reading path never waits for it). */
const SYNC_AFTER_SAVE_MS = 10_000

/** The reader's layout, a per-user setting (#1128): paginated unless the reader chose scrolled. No legacy preference is migrated. */
type Flow = 'paginated' | 'scrolled'
const FLOW_KEY = 'v2reader.flow'
/** #1312: the colour a new highlight takes, the last one chosen (the legacy reader's `lastHighlightColor`). */
const HIGHLIGHT_COLOR_KEY = 'v2reader.highlightColor'
/**
 * The reader's choice, read once for the process (like readerStorage) and replaced by every toggle: each page
 * load applies it before its first open, so the setting is never counted as a switch.
 */
let flowChoice: Promise<Flow> | null = null
const storedFlow = () => (flowChoice ??= AsyncStorage.getItem(FLOW_KEY).then((f) => (f === 'scrolled' ? 'scrolled' : 'paginated'), () => 'paginated'))

/** Expo's uuid v4 is the platform CSPRNG (java.util.UUID.randomUUID → SecureRandom). */
const freshNonce = () => nonceFromUuid(uuid.v4())

/**
 * The file the page is opening: retained (`books/…`) or staged (`staging/…`). The file path is the
 * `name` handed to `openUrl` and echoed in `opened`/`open-failed`, so an answer to an earlier open
 * is recognised instead of being paired with this one's file.
 */
type Opening = { file: string; name: string; format?: string | null }
const isStaged = (file: string) => file.startsWith('staging/')

/** The reader route's Back waits this long for the page's `book-closed` (its save in), then leaves anyway. */
const LEAVE_FALLBACK_MS = 1500

/** Logs a failure; `show` also puts it on screen (the screen's `showError`: a full disk as a human message, hostErrors.ts). */
const fail = (what: string, show?: (e: unknown) => void) => (e: unknown) => {
  console.log(`[v2] ${what} failed: ${e}`)
  show?.(e)
}

/**
 * An ended reading session (#1313) into the local library, keyed by the book's bytes, and queued: the outbox sends
 * it on the next pass (a save's, an open's, the screen's). No account, no network: never on the reading path.
 */
const saveSession = (e: EndedSession | null): Promise<unknown> => {
  if (!e) return Promise.resolve()
  return deviceLocalLibrary().addSession(e.book, e, uuid.v4).then(
    (kept) => { if (!kept) console.warn(`[v2] reading session not kept: no book with bytes ${e.book}`) },
    fail('reading session'),
  )
}
/** The library's key for the page's sha256 (hostStorage `sha256Key`); null when it is none. */
const sessionKey = (sha: unknown) => {
  try {
    return typeof sha === 'string' ? sha256Key(sha) : null
  } catch {
    return null
  }
}

/** The file's size for its `opened` deadline; unknown (null) gives the floor. */
const sizeOf = (file: string) => {
  try { return hostFile(file).size } catch { return null }
}

/** The WebView's verdict for the process (#1228, webViewVersion.ts): the reader page's first `ua` answer. */
const webViewCheck = createWebViewCheck()

/**
 * Android only (R2): the page reads its book from a native interceptor (bookOrigin.mjs, a react-native-webview patch)
 * that iOS does not have.
 * A WebView older than the page's floor swaps the reader for the update screen (#1228).
 */
export default function ReaderScreen() {
  const [verdict, setVerdict] = useState(webViewCheck.verdict)
  const { t } = useLanguage()
  if (Platform.OS !== 'android') return <Text>{t('reader.v2.androidOnly')}</Text>
  if (verdict === 'outdated') return <UpdateWebViewScreen />
  return <ReaderPage verdict={verdict} onUserAgent={(ua) => setVerdict(webViewCheck.answer(ua))} />
}

/** No "try again": the WebView provider is loaded once per process, so an update applies after a reopen. */
function UpdateWebViewScreen() {
  const { colors } = useTheme()
  const { t } = useLanguage()
  return (
    <SafeAreaView style={[styles.update, { backgroundColor: colors.background }]}>
      <View accessibilityRole="alert" style={styles.updateText}>
        <Text style={[styles.updateTitle, { color: colors.text }]}>{t('updates.webView.title')}</Text>
        <Text style={[styles.updateBody, { color: colors.textSecondary }]}>{t('updates.webView.body')}</Text>
      </View>
      <Pressable
        onPress={() => openPlayStorePage(webViewStorePackage(Number(Platform.Version)))}
        accessibilityRole="button"
        style={[styles.button, { backgroundColor: colors.primary }]}
      >
        <Text style={styles.buttonText}>{t('updates.webView.cta')}</Text>
      </Pressable>
    </SafeAreaView>
  )
}

/** Where the reader is, from the last `relocate` through `readRelocate`; null: nothing to show yet. */
type Place = { fraction: number | null; index: number | null; sections: number | null; toc: string; tocIndex: number | null; sectionEnd: number | null; words: number | null } | null

/**
 * The bottom bar (the legacy reader's footer): re-renders alone on every `relocate`, not the WebView beside it.
 * Its prev/next are page turns for now.
 */
function PlaceFooter({ setter, toc, onGoToc, ...props }: { setter: MutableRefObject<Dispatch<SetStateAction<Place>>>; toc: TocEntry[]; onGoToc: (entry: TocEntry) => void } & Omit<
  Parameters<typeof ReaderFooter>[0],
  'bookProgress' | 'chapterTitle' | 'currentChapterIndex' | 'totalChapters' | 'timeLeftLabel' | 'hasPrev' | 'hasNext' | 'above'
>) {
  const [place, setPlace] = useState<Place>(null)
  useEffect(() => { setter.current = setPlace }, [setter])
  const { t } = useLanguage()
  // V2 keeps no reading pace (no stats route): the population figure.
  const wpm = FALLBACK_WPM
  return (
    <ReaderFooter
      {...props}
      bookProgress={place?.fraction ?? null}
      // The current contents entry's title; never a section number (#1261): no index, no counter.
      chapterTitle={tocAround(toc, place?.tocIndex ?? null).current?.label ?? ''}
      currentChapterIndex={-1}
      totalChapters={0}
      timeLeftLabel={placeTimeLeftLabel(timeLeftAt({ fraction: place?.fraction, sectionEnd: place?.sectionEnd, totalWords: place?.words, wpm }), t)}
      hasPrev={!!place}
      hasNext={!!place}
      above={place && <SectionNav toc={toc} tocIndex={place.tocIndex} onGo={onGoToc} color={props.barText} />}
    />
  )
}

/** The page writes a save it still holds back (README `flush()`); `__fol` is absent only before the page ran. */
const FLUSH_JS = 'window.__fol && window.__fol.flush();true'

/** `verdict` other than `ok` (no or no readable answer yet): an old WebView is a likely cause of a missed `ready`. */
function ReaderPage({ verdict, onUserAgent }: { verdict: WebViewVerdict | null; onUserAgent: (ua: unknown) => void }) {
  const { colors, isDark } = useTheme()
  const { t, language } = useLanguage()
  /** The latest `t`, for callbacks made once (`reload`, the first render's `giveUp`): a language change reaches them. */
  const tRef = useRef(t)
  tRef.current = t
  const webView = useRef<WebView>(null)
  const [nonce, setNonce] = useState(freshNonce)
  const source = useMemo(() => pageSource(nonce), [nonce])
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  /** Which page answer belongs to which open (openTracker.mjs): a book kept on screen, a stale `restored`. */
  const [tracker] = useState(() => createOpenTracker<Opening>())
  const setProgress = useRef<Dispatch<SetStateAction<Place>>>(() => {})
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [heading, setHeading] = useState('')
  // null until the stored choice is read: the toggle is off until then, so no toggle can race the read.
  const [flow, setFlow] = useState<Flow | null>(null)
  useEffect(() => { storedFlow().then(setFlow) }, [])
  /** False for a fixed-layout book (CBZ): flow changes nothing there, so the toggle is off. */
  const [reflowable, setReflowable] = useState(true)
  /** Finish book (#1266): the book's end is on screen (`relocate.atEnd`), and the open book's format (`opened`). */
  const [atEnd, setAtEnd] = useState(false)
  const [format, setFormat] = useState<string | null>(null)
  /** The reading settings (#1260): sent whole on `ready` and on every change; the theme colours the bars. */
  const { settings, update: updateSettings } = usePageSettings()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const theme = THEMES[settings.theme]
  /** The book open at the last renderer crash: one that crashes it twice is not reopened again. */
  const crashedFile = useRef<string | null>(null)
  /**
   * Two lines (#1080 item 6): `openError` is the open's (pick, download, open-failed, a failed import, a crash)
   * and only a new open clears it; `error` is everything else (library, settings, sync, saves), so a later
   * `store` failure never overwrites why the book did not open.
   */
  const [openError, setOpenError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** A failure on screen (`fail`'s `show`): a full disk or an unreadable file in words, anything else as it is. */
  /**
   * A failure on screen (`fail`'s `show`): what failed in the reader's words (`reader.v2.failed.*`, never the log's
   * label), then why (a full disk or an unreadable file in words, anything else as it is).
   */
  const failedText = (what: string, e: unknown) => fill(what, { reason: hostError(e, tRef.current) })
  const showError = (what: string) => (e: unknown) => setError(failedText(what, e))
  const showOpenError = (what: string) => (e: unknown) => setOpenError(failedText(what, e))
  /** A deadline the page missed (deadlines.mjs, #1080 item 3); a late answer clears it. */
  const [overdue, setOverdue] = useState<Overdue>(null)
  const [deadlines] = useState(() => createDeadlines(setOverdue))
  /** The same open overdue twice in a row is given up (deadlines.mjs OPENED_OVERDUE_LIMIT). */
  const [strikes] = useState(() => createOverdueStrikes())
  /** A newer position from another device the reader is asked about (ADR-019 `prompt`). */
  const [offer, setOffer] = useState<PagePosition | null>(null)
  const [fileSync, setFileSync] = useState(false)
  const { user } = useAuth()
  const userId = user?.id ?? null
  /** The direction the open book pages in (`opened`, then every `relocate`): the keys and the tap zones follow it. */
  const pageDir = useRef<'ltr' | 'rtl'>('ltr')
  /**
   * The open book's bytes (normalised, hostStorage `sha256Key`): how the host knows it (finish book, sync, word
   * saves), never by id: a sync can re-key the row while it is read (#1266, #1303). State for the render (the
   * finish block); the ref for a sync pass in flight, which must see the latest.
   */
  const [openSha, setOpenShaState] = useState<string | null>(null)
  const openShaRef = useRef<string | null>(null)
  const setOpenSha = (sha: string | null) => {
    openShaRef.current = sha
    setOpenShaState(sha)
  }
  const [place] = useState(createMovedTracker)
  /** The reading session (#1313, sessionTracker.mjs), keyed by the open book's bytes as Finish book is. */
  const [sessions] = useState(createSessionTracker)
  /** The open book's contents (#1261, toc.mjs); the reader's place in them as of the last relocate, read when the sheet opens. */
  const [toc, setToc] = useState<TocEntry[]>([])
  const tocIndex = useRef<number | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  /** `?contents=1` (the book page's Contents): the sheet opens once the linked book is open, if it has contents. */
  const contentsOnOpen = useRef(false)
  /** A new open or a closed book: the previous book's contents go. */
  const clearToc = () => {
    setToc([])
    tocIndex.current = null
    setTocOpen(false)
  }

  const call = (js: string) => webView.current?.injectJavaScript(`${js};true`)
  /** #1426: the page's `describe` answers awaited, by request id. */
  const described = useRef(new Map<string, (d: FileDetails | null) => void>())
  /** The open book's details and cover from the page, or null (another open since, no answer in time, an error). */
  const describeOpen = (o: Opening | null) => new Promise<FileDetails | null>((done) => {
    // Calls run in order in the page: with no open started since `o`, the book it reads is `o`'s.
    if (!o || opening.current !== o || !ready.current) return done(null)
    const id = uuid.v4()
    const finish = (d: FileDetails | null) => { clearTimeout(timer); described.current.delete(id); done(d) }
    const timer = setTimeout(() => finish(null), DESCRIBE_MS)
    described.current.set(id, finish)
    call(`window.__fol.describe(${JSON.stringify(id)})`)
  })

  /**
   * Discuss this chapter (#1316): the chapter whose end is on screen (`relocate.chapterEnd`, the page's own test),
   * each chapter's share as far as it got (kept while the book is open), what the open book calls itself (`opened`:
   * untrusted text, sent as text), and the shared controller (the page's `chapter-text` answers awaited, one
   * operation id per chapter so a retry replays the first share).
   */
  const [chapterEnd, setChapterEnd] = useState<ChapterEnd | null>(null)
  const [discussStates, setDiscussStates] = useState<Record<string, DiscussState>>({})
  const discussBook = useRef<{ title: string; author: string | null; language: string | null } | null>(null)
  const discussUser = useRef(userId)
  discussUser.current = userId
  /** The chapters a Discuss runs for (shared `createDiscussLocks`): per chapter and open book, freed when the run ends, a book opens or closes, or the account changes. */
  const [discussLocks] = useState(createDiscussLocks)
  /** Only for the pick between two connected assistants (its Alert, the remembered choice): it decides nothing about grants. */
  const launcher = useAssistantLauncher({ eager: false })
  const [discuss] = useState(() => createDiscuss({
    askPage: (request, c) => call(`window.__fol.chapterText(${JSON.stringify(request)}, ${JSON.stringify(c.tocIndex)}, ${JSON.stringify(c.section)})`),
    share: syncApi.shareChapter,
    newId: uuid.v4,
  }))
  /** A new open or a closed book: the previous book's chapter end, shares, operation ids and running locks go. */
  /** Every Discuss run of this screen is over: none shows, none holds a chapter (a new open, another account). */
  const forgetDiscussRuns = () => {
    setDiscussStates({})
    discuss.reset()
    discussLocks.reset()
  }
  const clearDiscuss = () => {
    setChapterEnd(null)
    discussBook.current = null
    forgetDiscussRuns()
  }
  /**
   * The chat for a share, from the grants its run found (`ready.grants`): never asked again, so a failed or stale
   * request cannot turn into a connect sheet after the share, nor leave the launcher waiting.
   */
  const openChat = async (shared: DiscussShared, grants: readonly { clientName: string }[]) => {
    const choice = chooseChat(grants, await loadReviewAssistant())
    if (choice.kind === 'pick') return launcher.choose(() => shared.brief)
    if (choice.kind !== 'open') return
    Linking.openURL(handoffUrl(choice.assistant, shared.brief)).catch(() => showToast({ message: t('chapterReview.openFailed'), variant: 'error' }))
  }
  // #1316 review: another account (or none): a share in flight under the previous one shows nothing and holds
  // nothing, so the pill is usable at once without reopening the book.
  useEffect(() => { forgetDiscussRuns() }, [userId])
  /**
   * The chapter's text, read by the page, is shared with the reader's account, then the chat opens with the share's
   * id (`runDiscuss`). Online only: a failed, slow or offline step is said on the pill and hands over nothing.
   * Guarded by the identity it started under (the user, the session epoch, this open, these bytes): once any
   * changed, nothing is sent or shown.
   */
  const discussChapter = async (chapter: ChapterEnd) => {
    const sha = openShaRef.current
    const open = opening.current
    const book = discussBook.current
    const asker = discussUser.current
    const key = chapterKey(chapter)
    if (!sha || !open || !book) return
    const release = discussLocks.take(key)
    if (!release) return
    const stale = resetSince()
    const current = () => !stale() && discussUser.current === asker && opening.current === open && openShaRef.current === sha
    const set = (state: DiscussState | undefined) => {
      if (!current()) return
      setDiscussStates((all) => {
        const { [key]: _, ...rest } = all
        return state ? { ...rest, [key]: state } : rest
      })
    }
    set({ phase: 'sharing' })
    try {
      const state = await runDiscuss({
        canConnect: capabilitiesFor(user).canConnectAssistant,
        grants: oauthGrantsApi.listOAuthGrants,
        serverBook: () => deviceLocalLibrary().serverBookOf(sha),
        share: (server) => discuss.discuss(
          { ...chapter, ...server, chapterKey: key, chapterTitle: chapter.title, bookTitle: book.title, author: book.author, language: book.language },
          current,
        ),
        current,
      })
      if (state?.phase === 'failed') console.warn('[v2] chapter not shared:', state.reason)
      set(state)
      // One tap shares and opens: from the grants this run decided with.
      if (state?.phase === 'ready' && current()) void openChat(state.shared, state.grants)
    } finally {
      release()
    }
  }

  /**
   * #1315: in-book search (search.mjs, the web host's rule): the search the page was last asked and whether the open book
   * can be searched (the ref for the message handler, set with the state); the sheet, keyed by the book so a new one's
   * starts empty.
   */
  const [search, setSearchState] = useState<Search>(NO_SEARCH)
  const searchRef = useRef<Search>(NO_SEARCH)
  const setSearch = (s: Search) => {
    searchRef.current = s
    setSearchState(s)
  }
  /** Streamed results are put on screen at most once per SEARCH_RENDER_MS (search.mjs): not a render of the whole screen per section. */
  const [renderSearch] = useState(() => createSearchRenders(() => setSearchState(searchRef.current)))
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchBook, setSearchBook] = useState(0)
  /**
   * What the reader typed in the search sheet ('' clears): a new search under the next id, which ends the one running in
   * the page; with no query the page removes the hits it drew. The query is the reader's own text, never the book's.
   */
  const askSearch = (raw: string) => {
    const next = searchStart(searchRef.current, raw)
    setSearch(next)
    // A page not loaded yet (or reloading) holds no search to end.
    if (ready.current) call(`window.__fol.search(${JSON.stringify(next.query || null)}, ${next.id})`)
  }
  /**
   * A new open or a closed book: the previous book's search ends with it (its hits go from the page, if it still shows
   * that book), and nothing is searchable until the next `opened` says so (`searchReset`: the button goes meanwhile).
   */
  const clearSearch = () => {
    setSearchOpen(false)
    setSearchBook((n) => n + 1)
    if (searchRef.current.query && ready.current) call('window.__fol.search(null)')
    setSearch(searchReset(searchRef.current))
  }

  /** A book is on screen (the reader, with its bars) rather than the list; the ref for the message handler. */
  const [inBook, setInBook] = useState(false)
  const inBookRef = useRef(false)
  const setBook = (v: boolean) => {
    inBookRef.current = v
    setInBook(v)
  }
  /**
   * The word popup or selection toolbar (#1269, wordPopup.mjs `popupStep`, the web host's rule); the ref for the
   * message handler, set with the state. The sheet a toolbar button opened, with the text it acts on. The open book's
   * language (`opened.lang`, else the app's, as the legacy reader) and whether it takes highlights.
   */
  const [popup, setPopupState] = useState<Popup | null>(null)
  const popupRef = useRef<Popup | null>(null)
  const setPopup = (p: Popup | null) => {
    popupRef.current = p
    setPopupState(p)
  }
  /** #1265: the page shows an image full screen (its `lightbox` message); back closes it first (`closeLightbox()`). */
  const [lightbox, setLightbox] = useState(false)
  const [sheet, setSheet] = useState<{ kind: 'translate' | 'explain'; text: string; sentence: string } | null>(null)
  /**
   * #1312: the open book's drawn highlights (the page's `highlight-list`, for the bytes `openShaRef` names), their notes
   * (the local library's `notes()`, keyed by the page's ids: known, unknown, deleted; an id in none is new), the highlights
   * sheet, the colour a new highlight takes (the legacy bar's: the last one chosen), and a deep link's highlight still
   * to jump to (the dev route's `?book=&highlight=`, once).
   */
  const [highlightList, setHighlightList] = useState<HighlightItem[]>([])
  /** Null: this open's notes not read yet (an editor waits). Keyed by the page's ids (a re-keyed one's old id too). */
  const [notes, setNotes] = useState<BookNotes | null>(null)
  /** The page listed a changed highlight set: the notes are read again once its `store` is written (#1312 review). */
  const notesStale = useRef(false)
  const [highlightsOpen, setHighlightsOpen] = useState(false)
  /**
   * #1314: the open book's bookmarks, the one on screen and whether one can be made here (the page's `bookmark-list`,
   * for the bytes `openShaRef` names; null until it comes), and their sheet. A bookmark is the local library's
   * annotation row of colour `bookmark`: stored, queued and tombstoned by the highlights' own path.
   */
  const [bookmarks, setBookmarks] = useState<BookmarkList | null>(null)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  /** `opened.bookmarkable`: a bookmark can be made somewhere in the open book (false: an image book, a PDF, a pre-paginated EPUB). */
  const [bookmarkable, setBookmarkable] = useState(false)
  const [highlightColor, setHighlightColor] = useState<HighlightColor>('yellow')
  useEffect(() => { AsyncStorage.getItem(HIGHLIGHT_COLOR_KEY).then((c) => setHighlightColor(colorOf(c)), () => {}) }, [])
  const chooseColor = (c: HighlightColor) => {
    setHighlightColor(c)
    AsyncStorage.setItem(HIGHLIGHT_COLOR_KEY, c).catch(() => {})
  }
  const pendingHighlight = useRef<string | null>(null)
  /** Highlight editor openings: the editor's key, so an event that leaves the same highlight open keeps its typed draft. */
  const editorOpening = useRef(0)
  /** A failed read is tried once more; failed again, the next highlight list tries again (editors wait meanwhile). */
  const notesRead = useRef(false)
  const refreshNotes = (retry = true) => {
    const sha = openShaRef.current
    if (sha) readerStorage().notes(sha).then((m) => {
      if (openShaRef.current !== sha) return
      notesRead.current = true
      setNotes(m)
    }, (e) => (retry ? refreshNotes(false) : fail('notes')(e)))
  }
  /** A page message for the open book (its `key`, the page's lower-case sha256). */
  const isOpenKey = (key: string) => openShaRef.current !== null && key.toLowerCase() === openShaRef.current
  /** The reader's choice (a highlight or bookmark in its sheet, a deep link, a search result): saved where it lands. */
  const goHighlight = (h: { cfi: string }) => {
    startHostMove()
    call(`window.__fol.goTo(${JSON.stringify(h.cfi)}, true)`)
  }
  /** #1314: the bookmark on screen removed, else one added at the place on screen: the page stores it (`store`) or answers `highlight-removed`. */
  const toggleBookmark = () => {
    const here = bookmarks?.here
    call(here ? `window.__fol.removeBookmark(${JSON.stringify(here)})` : 'window.__fol.addBookmark()')
  }
  const [bookLang, setBookLang] = useState<string | null>(null)
  /**
   * #1272: Listen. The language the open book is spoken in (listen.mjs `ttsLang` of `opened.lang`, else the
   * translation's fallback; null: no Listen), the chosen speed, the legacy player, and listen.mjs `createListener`
   * (the web host's rule; it owns the phase, this renders it): a press speaks or stops, the page marks the range
   * (`speaking`) until playback ends; a failure is a toast.
   */
  const [ttsLanguage, setTtsLanguage] = useState<string | null>(null)
  const { speed: ttsSpeed, update: updateTtsSpeed } = useTtsSpeed()
  const tts = useTts()
  const ttsRef = useRef({ tts, lang: ttsLanguage, speed: ttsSpeed, call, fail: () => {} })
  ttsRef.current = { ...ttsRef.current, tts, lang: ttsLanguage, speed: ttsSpeed, call }
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [listener] = useState(() => createListener({
    speak: (text, done) => {
      const { tts: x, lang, speed } = ttsRef.current
      return lang ? x.speak(text, { lang, rate: speed, onEnd: done }) : false
    },
    stop: () => ttsRef.current.tts.stop(),
    mark: (at) => ttsRef.current.call(speakingJs(at)),
    changed: rerender,
    failed: () => ttsRef.current.fail(),
  }))
  // Leaving the screen ends the speech through the listener: a host-side end is never a failure toast elsewhere.
  useEffect(() => () => listener.stop(), [])
  useEffect(() => () => { if (leaving.current) clearTimeout(leaving.current) }, [])
  // The word bar or selection toolbar that started a Listen closed (or another opened): its speech stops, its mark goes.
  useEffect(() => {
    listener.follow(spokenOf(popup))
  }, [popup])
  // No background audio (audit §2.7): the app leaving the foreground ends the speech.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { if (st !== 'active') listener.stop() })
    return () => sub.remove()
  }, [])
  const [annotatable, setAnnotatable] = useState(true)
  /** Counts opens: each one shows the bars and re-arms their auto-hide, also when replayed in the book. */
  const [opens, setOpens] = useState(0)
  /** The flow the book pages by: a fixed-layout book pages whatever the setting. */
  const effectiveFlow: Flow = reflowable ? flow ?? 'scrolled' : 'paginated'
  const insets = useSafeAreaInsets()
  // The page keeps the inset it had with the status bar shown: hiding the bars must not resize (re-lay out) the book.
  const topPad = useRef(0)
  topPad.current = Math.max(topPad.current, insets.top)
  const bottomPad = useRef(0)
  bottomPad.current = Math.max(bottomPad.current, insets.bottom)
  const safeInsets = { top: topPad.current, bottom: bottomPad.current, left: insets.left, right: insets.right }
  const scrollIntent = useRef(createScrollIntent())
  const manualBarsAt = useRef(0)
  useEffect(() => { scrollIntent.current.reset() }, [inBook, flow, opens])
  useEffect(() => {
    if (ready.current) call(`window.__fol.insets(${JSON.stringify(safeInsets)})`)
  }, [safeInsets.top, safeInsets.bottom, safeInsets.left, safeInsets.right])
  const [footerHeight, setFooterHeight] = useState(0)
  const { barsVisible, barsAnim, topBarTranslateY, footerTranslateY, showBars, hideBars, toggleBars } = useReaderBars({
    topBarHeight: 56 + insets.top,
    footerHeight: footerHeight || 60 + insets.bottom,
    autoHideTrigger: inBook ? opens : 0,
  })
  useKeepReaderAwake(inBook)
  /** The page viewport's width (the WebView's), the space of `tap.x`. */
  const pageWidth = useRef(0)
  /** Bar buttons and the taken offer: the page counts their moves as the reader's, but they keep the bars up. */
  const [hostMoves] = useState(createHostMoves)
  const startHostMove = () => {
    scrollIntent.current.reset()
    hostMoves.start()
  }
  const barTurn = (dir: 'prev' | 'next') => {
    startHostMove()
    call(`window.__fol.${dir}()`)
  }
  /**
   * A contents entry the reader chose (the sheet, the footer's section controls): the page saves where it lands.
   * It is the current one at once: a jump within the view on screen may send no relocate.
   */
  const goToc = (e: TocEntry) => {
    tocIndex.current = e.index
    setProgress.current((p) => p && { ...p, tocIndex: e.index })
    startHostMove()
    call(`window.__fol.goTo(${JSON.stringify(e.href)}, true)`)
  }

  // The page's debounced save (400 ms) is written on background (the page also flushes itself when its document
  // turns hidden); the unmount call is best effort (useFlushOnLeave). Closing a book flushes through CLOSE_BOOK_JS.
  const flushPage = useCallback(() => { webView.current?.injectJavaScript(FLUSH_JS) }, [])
  useFlushOnLeave(flushPage)

  // The reader route (`/my-books/read/[bookId]/…`, M5 #1031) names its book `bookId`; the dev route's deep link `book`.
  const params = useLocalSearchParams<{ book?: string; bookId?: string; highlight?: string; contents?: string }>()
  const linkedBook = params.book ?? params.bookId
  /**
   * On the reader route the book is the screen: Back flushes it (`CLOSE_BOOK_JS`) and leaves the route on its
   * `book-closed`, or after LEAVE_FALLBACK_MS if that never comes. The dev route's list stays dev-only.
   */
  const onRoute = !!params.bookId
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leave = () => {
    if (leaving.current) clearTimeout(leaving.current)
    leaving.current = null
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }
  /**
   * Back or the top bar: the list at once (the hidden page takes no tap or key from here), then the book ends
   * once the page's pending save is in (`CLOSE_BOOK_JS`: `store`, then `book-closed`). No page to flush: at once.
   * On the reader route: the same flush, then the route is left (above).
   */
  const closeBook = () => {
    if (onRoute) {
      if (leaving.current) return
      if (!ready.current) return leave()
      leaving.current = setTimeout(leave, LEAVE_FALLBACK_MS)
      webView.current?.injectJavaScript(CLOSE_BOOK_JS)
      return
    }
    setBook(false)
    deadlines.answered()
    if (ready.current) webView.current?.injectJavaScript(CLOSE_BOOK_JS)
    else endBook()
  }
  /** The closed book is no longer the open one: a later `ready` opens nothing, and its per-book state goes. */
  const endBook = () => {
    saveSession(sessions.open(Date.now()))
    listener.stop()
    opening.current = null
    setOpenSha(null)
    place.open()
    setReflowable(true)
    setAtEnd(false)
    clearDiscuss()
    pageDir.current = 'ltr'
    setProgress.current(null)
    clearToc()
    clearSearch()
    setPopup(null)
    setOffer(null)
    setLightbox(false)
    setHeading('')
    pendingHighlight.current = null
    setHighlightList([])
    setHighlightsOpen(false)
    setBookmarks(null)
    setBookmarksOpen(false)
  }

  /**
   * A `tap` (never a link or a press that dismissed a selection: the page sends none for those), a `word` or a
   * selection (validated): what is open and what the tap zones do (wordPopup.mjs `popupStep`): an edge turns the page,
   * a word elsewhere opens its popup, the centre toggles the bars. A fixed-layout book pages whatever the flow setting.
   */
  const onPopupEvent = (e: PopupEvent) => {
    const { popup: next, turn } = popupStep(popupRef.current, e, { width: pageWidth.current, flow: effectiveFlow, dir: pageDir.current })
    // Only another highlight's editor is a new one (its key): a pass-through event (a move, a cleared selection) keeps
    // the same, and its typed draft (#1312 review).
    const was = popupRef.current
    if (next?.kind === 'highlight' && !(was?.kind === 'highlight' && was.id === next.id)) editorOpening.current++
    // An editor opening while this open's notes were never read (both reads failed): read again, it waits meanwhile.
    if (next?.kind === 'highlight' && !notesRead.current) refreshNotes()
    setPopup(next)
    if (turn === 'toggle') { manualBarsAt.current = Date.now(); return toggleBars() }
    if (!turn) return
    call(`window.__fol.${turn}()`)
    hideBars()
  }
  /** The bar closed (its ×, Copy, back, Escape); a selection's goes in the page too (clearSelection, as the web host). */
  const closePopup = () => {
    if (popupRef.current?.kind === 'selection') call('window.__fol.clearSelection()')
    setPopup(null)
  }
  /**
   * Saving a word (#1270): the legacy reader's Save, through the app's vocabulary API (V2), with the
   * word's sentence, the book and its title; what the answer shows: vocabSave.mjs. Off the reading path: nothing here
   * waits on it, a failure is a toast. No offline queue (the legacy reader has none).
   */
  const router = useRouter()
  const haptics = useHaptics()
  const { show: showToast } = useToast()
  // #1347: no voice for the language is no failure to report: Listen just goes.
  ttsRef.current.fail = () => {
    const l = ttsRef.current.lang
    if (!l || ttsHasVoice(l)) showToast({ variant: 'error', message: t('reader.listenFailed') })
  }
  const { nativeLanguage } = useNativeLanguage()
  const bookTitle = useRef<string | null>(null)
  /** The words (vocabMapKey) whose save is in flight: a second press of the same word waits, another word saves. */
  const savingWords = useRef(new Set<string>())
  /**
   * #1271: the reader's saved words are the local library's `vocabulary` rows: the vocabulary feed's, and this device's
   * own saves (each answer's card upserted, a translation stored on the server written to its row), so the marks, the
   * bar's ✓ and a guest's nudge read one list, offline too. Read at each open, after each own write and after each sync
   * pass; the book's language's words go to the page with the gloss setting (the legacy reader's own
   * `showInlineTranslations`), which marks each section as it loads. `vocabEpoch` is bumped by an open and by a user
   * change: a read of an older one lands nowhere; a save answer lands only for the user who asked it.
   */
  const { settings: legacySettings, update: updateLegacySettings } = useReaderSettings()
  const glosses = useRef(legacySettings.showInlineTranslations)
  glosses.current = legacySettings.showInlineTranslations
  const vocab = useRef<ReaderWord[]>([])
  /** The rows as state, for the bar's ✓. */
  const [vocabRows, setVocabRows] = useState<readonly ReaderWord[]>([])
  const vocabEpoch = useRef(0)
  /** The user the rows are read for: a save answer for another one is dropped, never written. */
  const vocabUser = useRef(userId)
  /** The language the book's words are saved under (`textLang`, set each render): what is marked and filled. */
  const vocabLang = useRef<string | null>(null)
  /** The open (epoch) whose rows are in: the backfill's latch, with the user and the native language. */
  const [vocabOpen, setVocabOpen] = useState(0)
  /** The last list sent (JSON), so an unchanged one is not sent again. */
  const marksSent = useRef<string | null>(null)
  const sendMarks = () => {
    if (!ready.current) return
    const js = `window.__fol.markWords(${JSON.stringify(markWordsOf(forBook(vocab.current, vocabLang.current)))}, ${glosses.current})`
    if (js === marksSent.current) return
    marksSent.current = js
    call(js)
  }
  const readVocab = (epoch = vocabEpoch.current) => Promise.all([deviceLocalLibrary().savedWords(), deviceLocalLibrary().account()]).then(([all, owner]) => {
    if (epoch !== vocabEpoch.current) return false
    // Another identity's library (a wipe that failed) is never read for this user's marks.
    const rows = ownsLibrary(owner, vocabUser.current) ? all : []
    vocab.current = rows
    setVocabRows(rows)
    sendMarks()
    return true
  }, (e) => { fail('vocabulary')(e); return false })
  /** An open, or a user change: the rows read anew, then the backfill for them. */
  const loadVocab = () => {
    const epoch = ++vocabEpoch.current
    void readVocab(epoch).then((ok) => { if (ok) setVocabOpen(epoch) })
  }
  /** After a sync pass or an own write: the rows again (another device's words, a tombstone, a pulled-back card). */
  const refreshVocab = () => { if (vocabEpoch.current) void readVocab() }
  /**
   * What an own write carries from the moment its save was asked (#1271 review): the user, the library's owner and
   * session (`guard`, checked inside the write's job: a wipe or an adoption since means no write), and whether the save
   * went through V2 (a legacy card makes no V2 row). Null when this user may not write this library (another's owner).
   */
  type WriteCtx = { asker: string | null; guard: WriteGuard }
  /** Taken from memory when the save is asked (never waiting on the database); the library is checked by the write. */
  const writeContext = (): WriteCtx => {
    const asker = vocabUser.current
    return { asker, guard: { user: asker, stale: resetSince() } }
  }
  /** A save's answer card (saved, already saved, restored) into the rows, if its context still holds. */
  const takeWord = async (w: { id: string; word: string; language?: string | null; stage: number; translation: string | null } | null | undefined, ctx: WriteCtx) => {
    const row = answerRow(w, ctx.asker, vocabUser.current, vocabLang.current, !!w)
    if (row) await deviceLocalLibrary().upsertWord(row, ctx.guard).then(refreshVocab, fail('vocabulary'))
  }
  /** The card after a translation write (`onlyIfEmpty`): its translation, the server's, on its row too (a V2 card only). */
  const takeTranslation = async (id: string, card: { translation?: string | null } | null | undefined, ctx: WriteCtx) => {
    const tr = serverTranslation(card)
    if (!tr || ctx.asker !== vocabUser.current) return
    await deviceLocalLibrary().setWordTranslation(id, tr, ctx.guard).then(refreshVocab, fail('vocabulary'))
  }
  /** Card ids whose TR-2 fill is in flight: the backfill leaves them to it. */
  const filling = useRef(new Set<string>())
  useEffect(() => { sendMarks() }, [legacySettings.showInlineTranslations])
  // A user change (sign-out, another account, a guest becoming an account): the rows read anew for it (a wipe, an
  // adoption and the next pull have made them that user's), the backfill latched again; an older answer lands nowhere.
  useEffect(() => {
    if (vocabUser.current === userId) return
    vocabUser.current = userId
    if (vocabEpoch.current) loadVocab()
  }, [userId])
  /** False when the book's `opened.lang` does not read (savesWords): its words would be filed under the fallback. */
  const [langSaves, setLangSaves] = useState(true)
  const closeIfOpen = (p: Popup) => { if (popupRef.current === p) closePopup() }
  const wordSavedToast = async () => {
    haptics.play('complete')
    const added = () => showToast({
      variant: 'success', message: t('reader.toastWordAdded'), actionLabel: t('reader.toastTapToReview'),
      onPress: () => router.push('/vocabulary'), duration: 2400,
    })
    if (!capabilitiesFor(user).isGuest) return added()
    // A guest's 3rd and 10th word (legacy: counted on the reader's whole vocabulary): the open's words in memory (#1271).
    // The rows once the feed is pulled (the server answered), else the server's list (nudgeCount).
    const count = await nudgeCount(
      async () => (await syncOn()) && (await deviceLocalLibrary().cursor('vocabulary')) !== null,
      vocab.current,
      () => vocabularyApi.getReaderVocab().then((w) => w.length),
    )
    const nudge = await claimGuestNudge(true, count)
    if (!nudge) return added()
    showToast({
      variant: 'success', message: t(nudge === 'ten' ? 'guest.nudgeTen' : 'guest.nudgeThree'), actionLabel: t('guest.nudgeCta'),
      onPress: () => router.push({ pathname: '/(auth)/login', params: { mode: 'register', then: 'back' } }), duration: 6000,
    })
  }
  const restoreWord = async (_p: Popup, id: string) => {
    const ctx = writeContext()
    return vocabularyApi.restoreWord(id).then(
    (w) => { void takeWord(w, ctx) },
    () => showToast({ variant: 'error', message: t('reader.vocab.restoreFailed') }),
    )
  }
  /**
   * Remove: the legacy reader's (useReaderVocabActions `removeWord`, the same bar's trash button), an accidental save
   * undone. Optimistic: unmarked at once; deleted, the bar closes and the next sync pass pulls the tombstone that drops
   * the row; failed, the row's mark comes back. A later Save saves it anew.
   */
  const removeWord = (p: Popup, id: string) => {
    const rows = vocab.current.filter((w) => w.id !== id)
    vocab.current = rows
    setVocabRows(rows)
    sendMarks()
    vocabularyApi.deleteWord(id).then(() => { closeIfOpen(p); syncSoon() }, (e) => {
      console.warn('[v2] word not removed:', e)
      refreshVocab()
      showToast({ variant: 'error', message: t('reader.vocab.removeFailed') })
    })
  }
  const saveWord = async (p: Popup, translation?: string) => {
    if (p.kind === 'highlight' || !langSaves) return
    const text = p.kind === 'word' ? p.word : p.text.trim()
    if (text.length > MAX_VOCABULARY_TEXT) return showToast({ variant: 'info', message: t('reader.actionBar.saveTooLong') })
    const intent = saveWordIntent({ isAuthenticated: !!user, hasSelection: true })
    if (intent === 'prompt') {
      haptics.play('flip')
      showToast({ variant: 'info', message: t('reader.vocab.saveNeedsAccount'), duration: 3600, bottomOffset: footerHeight })
      return
    }
    const key = vocabMapKey(text)
    if (intent !== 'save' || savingWords.current.has(key)) return
    savingWords.current.add(key)
    const asker = vocabUser.current
    const ctx = writeContext()
    const body = { word: text, translation, language: textLang, nativeLanguage, sentence: p.sentence || null, bookTitle: bookTitle.current }
    try {
      // The open book's id from the list in memory, else from its row; a re-key since then is asked of the row on
      // `book_not_found` (wordBook.ts, #1303). A book the server does not have: the word is saved without it.
      const sha = openShaRef.current
      const { saved: resp, bookId } = await saveWordForBook(openBook?.id ?? null, {
        save: (id) => saveWordWithRetry(id ? { ...body, userBookId: id } : body),
        resolve: () => (sha ? readerStorage().bookIdOf(sha) : Promise.resolve(null)),
        isNotFound: (e) => syncApi.syncErrorOf(e)?.code === 'book_not_found',
      })
      // Another user since the save was asked: its answer is not this user's.
      if (asker !== vocabUser.current) return
      const o = saveOutcome(resp)
      if (o.kind === 'saved') {
        // The card in the rows first: the ✓, its marks and the nudge's count read them.
        void takeWord(o.word, ctx).then(() => wordSavedToast())
        // TR-2, as the legacy reader: a card saved without a translation gets one in the reader's language; the card the
        // server answers with goes to its row; the backfill leaves this card alone meanwhile.
        filling.current.add(o.word.id)
        fillSavedTranslation(o.word, text, textLang, nativeLanguage, {
          sentence: p.sentence, bookId: bookId ?? undefined, onStored: (card) => { void takeTranslation(o.word.id, card, ctx) },
          // Left to the backfill again only once its write settled (or there was none).
          onSettled: () => { filling.current.delete(o.word.id) },
        }).catch(() => {})
      } else if (o.kind === 'deleted') {
        showToast({
          variant: 'info', message: t('reader.vocab.deletedEarlier').replace('{{word}}', text), duration: 6000,
          actionLabel: t('reader.vocab.restore'), onPress: () => { void restoreWord(p, o.id) },
        })
      } else if (o.kind === 'pending') {
        showToast({ variant: 'info', message: t('reader.vocab.queuedForTomorrow') })
        closeIfOpen(p)
      } else if (o.kind === 'already_saved') {
        void takeWord(o.word, ctx)
        closeIfOpen(p)
      }
    } catch (e) {
      console.warn('[v2] word not saved:', e)
      showToast({ variant: 'error', message: t('reader.v2.saveWordFailed') })
    } finally {
      savingWords.current.delete(key)
    }
  }
  /** A translation or explanation closed: its selection is done, as on the web (the bar goes with it). */
  const closeSheet = () => {
    setSheet(null)
    closePopup()
  }
  const refreshBooks = () => readerStorage().books().then(setBooks, fail('library', showError(t('reader.v2.failed.library'))))
  useEffect(() => {
    refreshBooks()
    deviceLocalLibrary().fileSync().then(setFileSync, fail('settings'))
  }, [])

  /**
   * A programmatic move: where it lands is not the reader moving (movedTracker.mjs). The whole position
   * goes (README, `goTo`): not `chosen` (a sync adopt or move, already stored here) the page saves
   * nothing and takes it as its own; `chosen` (the reader took an offer) it saves where it landed.
   */
  const goTo = (p: PagePosition, chosen = false) => {
    place.hostMove()
    // Both chosen and sync moves can emit delayed scroll events; neither is a reading gesture.
    startHostMove()
    call(`window.__fol.goTo(${JSON.stringify(p)}, ${chosen})`)
  }

  // Opportunistic sync (R6): with a session (a guest's too), on open, after saves, never on the reading path.
  const sync = useRef((_retryFailed?: boolean) => {})
  sync.current = (retryFailed = false) => {
    if (!userId) return
    syncLibrary(deviceLocalLibrary(), {
      userId,
      retryFailed,
      newId: uuid.v4,
      // By the open book's bytes, not an id taken at open: this pass may re-key it (#1303).
      ...openBookHost(() => openShaRef.current, () => place.reader(), (a) => {
        if (a.action === 'prompt') setOffer(a.position)
        else goTo(a.position)
      }),
      upload: uploadRetained,
      guest: capabilitiesFor(user).isGuest,
    }).then(() => {
      // A pull may have brought another device's notes (#1312 review): the editor and the sheet read them again.
      refreshNotes()
      // And saved words (#1271): the marks too.
      refreshVocab()
      // The pass counts once its books are on screen: a linked book it pulled is found first (#1361).
      return refreshBooks()
    }, fail('sync')).finally(() => setSyncPasses((n) => n + 1))
  }
  /** Sync passes ended (either way): a linked book not in the library after one is not coming by itself. */
  const [syncPasses, setSyncPasses] = useState(0)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const syncSoon = () => {
    clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => sync.current(), SYNC_AFTER_SAVE_MS)
  }
  // A session's first pass retries every entry that stopped being retried (an outage heals on the next launch).
  useEffect(() => {
    sync.current(true)
    return () => clearTimeout(syncTimer.current)
  }, [userId])

  // The reading session (#1313): the heartbeat ends an idle one; the background, another identity and the
  // unmount end it (the legacy reader's rules); so does sign-out, before its push (#1322, openSession.ts).
  // The next activity starts another.
  useEffect(() => {
    const release = holdOpenSession(() => saveSession(sessions.end(Date.now())))
    const beat = setInterval(() => saveSession(sessions.tick(Date.now())), SESSION_HEARTBEAT_MS)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') saveSession(sessions.end(Date.now()))
    })
    return () => {
      clearInterval(beat)
      sub.remove()
      release()
      saveSession(sessions.end(Date.now()))
    }
  }, [userId])

  const toggleFileSync = () => {
    const next = !fileSync
    setFileSync(next)
    deviceLocalLibrary().setFileSync(next).then(
      () => next && sync.current(),
      (e) => {
        // The setting did not land: the toggle shows what is stored, and the reader is told.
        setFileSync(!next)
        fail('file sync setting', showError(t('reader.v2.failed.fileSync')))(e)
      },
    )
  }

  /** A book only the server has: fetched on demand, then opened. */
  const download = (b: LibraryBook): Promise<boolean> => {
    setOpenError(null)
    // As a pick's copy (#1273): a book opened while this one downloads is not replaced; the download stays in the library.
    const current = tracker.pick()
    return downloadBook(deviceLocalLibrary(), b.id, downloadIo).then(
      async (ok) => {
        // #1526: a Download of the same book that landed first leaves this one nothing to add; its file opens all the same.
        if (!ok && !(await deviceLocalLibrary().hasLocalBytes(b.sha256))) return false
        await refreshBooks()
        if (current()) open({ file: bookFile(b.sha256), name: b.originalName, format: b.format })
        return true
      },
      (e: unknown) => {
        fail('download', showOpenError(t('reader.v2.failed.download')))(e)
        return false
      },
    )
  }

  /** "Try again" on a book not synced (sync.ts `tryAgainBook`). */
  const unpark = (b: LibraryBook) => {
    setError(null)
    tryAgainBook(deviceLocalLibrary(), b.id, refreshBooks, () => sync.current()).catch(fail('unpark', showError(t('reader.v2.failed.unpark'))))
  }

  const open = (target: Opening) => {
    // The URL first: a name the interceptor would not serve (never one this host makes) is refused before any
    // state moves, as a failed open (its staged file dropped).
    const url = bookUrl(target.file)
    if (!url) {
      if (isStaged(target.file)) readerStorage().dropStaged(target.file).catch(fail('drop'))
      return setOpenError(fill(t('reader.v2.cannotOpen'), { name: target.name, reason: t('reader.v2.notServed') }))
    }
    // A deep link's highlight belongs to its book: another book's open drops it; this book opened again (the reopen on a
    // page's `ready`, #1312 review) keeps it.
    if (target.file !== opening.current?.file) pendingHighlight.current = null
    // The previous book's speech ends with it (its mark goes with the page's swap).
    listener.stop()
    // A superseded open's staged file is dropped once another book is taken (`takeOpened`): until then the
    // page may still keep that book on screen, if this newer open fails before its swap.
    opening.current = { ...target } // a new object even for the same file: an older onOpened sees it was superseded
    tracker.open(target.file, opening.current)
    saveSession(sessions.open(Date.now()))
    setOpenSha(null)
    setHighlightList([])
    setBookmarks(null)
    setNotes(null)
    notesRead.current = false
    place.open()
    setOffer(null)
    setOpenError(null)
    setError(null)
    setHeading(fill(t('reader.v2.opening'), { name: target.name }))
    setProgress.current(null)
    setAtEnd(false)
    clearDiscuss()
    clearToc()
    clearSearch()
    setPopup(null)
    setBook(true)
    showBars()
    setOpens((n) => n + 1)
    if (!ready.current) return
    deadlines.waitOpened(sizeOf(target.file))
    // The library's format for the file: a clip ('html') opens as one, never guessed from its bytes.
    call(`window.__fol.openUrl(${JSON.stringify(url)}, ${JSON.stringify(target.file)}, ${JSON.stringify(target.format ?? null)})`)
  }

  /** The page's book is `t.open`'s: every other open still pending is over, and its staged file goes. */
  const takeOpened = (t: Take<Opening, any>) => {
    for (const o of t.dropped) if (isStaged(o.file) && o.file !== t.open.file) readerStorage().dropStaged(o.file).catch(fail('drop'))
    opening.current = t.open
    saveSession(sessions.bind(sessionKey(t.opened.book?.sha256), Date.now()))
    setReflowable(t.opened.reflowable !== false)
    setFormat(typeof t.opened.format === 'string' ? t.opened.format : null)
    // Not `atEnd`: it was cleared where the open started; the book's first relocate (its end, for a book one
    // screen long) comes before this `opened` and must stand.
    setAnnotatable(t.opened.annotatable !== false)
    setBookmarkable(t.opened.bookmarkable === true)
    // #1315: strictly true where the page can search the book (not a CBZ or a PDF).
    setSearch(searchOpened(searchRef.current, t.opened))
    // The previous book's highlights and bookmarks go; this one's lists follow its `restored`.
    setHighlightList([])
    setBookmarks(null)
    setBookLang(readLang(t.opened))
    // #1316 review: the page's book is this open now (it may not be the one started last): no run of another holds on.
    forgetDiscussRuns()
    discussBook.current = {
      title: titleOf(typeof t.opened.title === 'string' ? t.opened.title : null, t.open.name),
      author: typeof t.opened.author === 'string' && t.opened.author ? t.opened.author : null,
      language: readLang(t.opened),
    }
    setTtsLanguage(ttsLang(t.opened.lang, readerTextLanguage(readLang(t.opened), language)))
    setLangSaves(savesWords(t.opened))
    loadVocab()
    onOpened(t.open, t.opened).catch(fail('opened', showOpenError(tRef.current('reader.v2.failed.opened'))))
  }

  /** Picks still copying their file into staging/ (#1273): shown, as a large or cloud file takes a while. */
  const [copying, setCopying] = useState(0)
  useEffect(() => () => tracker.dispose(), [])
  const pick = async () => {
    try {
      // Any file: the page tells the format by its bytes (EPUB, MOBI/AZW3, FB2, CBZ, PDF) and refuses the rest.
      // No picker cache copy (#1080 items 4–5): a moved cache copy keeps the cache's group, so Android counts the
      // retained book as app cache, and a full disk leaves a partial in cache/DocumentPicker/. stagePicked copies the URI.
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: false })
      if (result.canceled) return
      const asset = result.assets[0]
      const current = tracker.pick()
      setCopying((n) => n + 1)
      const file = await readerStorage().stagePicked(asset.uri).finally(() => setCopying((n) => n - 1))
      // A later open or pick (or an unmount) came during the copy (#1273): this one must not replace it.
      if (!current()) return void readerStorage().dropStaged(file).catch(fail('drop'))
      open({ file, name: asset.name })
    } catch (e) {
      fail('pick', showOpenError(t('reader.v2.failed.pick')))(e)
    }
  }

  const onOpened = async (current: Opening, m: { book: { sha256: string; size: number }; format?: string; title: string; author: string }) => {
    const s = readerStorage()
    // A reload or a new pick can replace this open during any await; then this answer stops there.
    const superseded = () => opening.current !== current
    // The page shows this book now: its title before any await, so a failed read below leaves no "Opening …".
    const title = titleOf(m.title, current.name)
    setHeading([title, m.author].filter(Boolean).join(' — '))
    bookTitle.current = title
    const stored = await s.readStore(m.book.sha256)
    if (superseded()) return
    call(`window.__fol.restore(${JSON.stringify(stored)})`)
    // From here a sync pass matches this book by its bytes (openBookHost), even if addOpened fails. Only after the
    // restore is posted: the page runs navigations in order, so a sync's goTo for this book can only follow it.
    // #1312: the one open-book key, set here for the highlights too: this open's `restored` and `highlight-list` come after
    // the restore just posted, so they always find it set. Its notes are read now.
    setOpenSha(sha256Key(m.book.sha256))
    refreshNotes()
    const { retained, books } = await s.addOpened(
      { ...m.book, title, author: m.author, originalName: current.name, format: m.format ?? null },
      isStaged(current.file) ? current.file : null,
    ).catch((e) => {
      // The staged path is gone once addOpened moved or dropped it: a reload must not reopen it.
      if (!superseded()) opening.current = null
      throw e
    })
    setBooks(books)
    // From here on this book is the retained copy: a reloaded page reopens that, not the moved staging file.
    if (superseded()) return
    opening.current = { ...current, file: retained }
    sync.current()
    // #1426: a book uploaded before the page read files gets its details, once; beside the open, never in its way. A book
    // picked here is not on the server yet: it is filled on an open after it synced. ADR-033 P3: a file the server has
    // no TOC for gets the page's, the same way; one `describe` serves both.
    const mine = opening.current
    if (discussUser.current) NetInfo.fetch().then((n) => {
      if (!n.isConnected) return
      let details: Promise<FileDetails | null> | null = null
      const describe = () => (details ??= describeOpen(mine))
      void fillBookMeta(m.book.sha256, describe)
      void syncOpenedToc(sha256Key(m.book.sha256), (sha) => deviceLocalLibrary().serverBookOf(sha), async () => (await describe())?.toc)
    }, () => {})
  }

  /** An open that ends without a book: dropped with its staged file, the reader told why. */
  function giveUp(o: { file: string; name: string }, reason: string) {
    opening.current = null
    if (isStaged(o.file)) readerStorage().dropStaged(o.file).catch(fail('drop'))
    // The old book may still post a relocate until the page takes up this open (file read + messages in
    // flight); a failure must not leave it standing after open() cleared it (#1168).
    setProgress.current(null)
    setBook(false)
    // Not the previous book's title (#1080 item 6): the error line names this file.
    setHeading('')
    setOpenError(fill(tRef.current('reader.v2.cannotOpen'), { name: o.name, reason }))
  }

  const onMessage = (event: WebViewMessageEvent) => {
    let m: any
    try { m = JSON.parse(event.nativeEvent.data) } catch { return }
    if (!m || typeof m !== 'object') return
    // Until the WebView said what it is, only that answer is taken: on an engine without frame-aware messaging
    // (the patch's fallback bridge) any frame can post, and those engines never get past the update screen.
    if (webViewCheck.verdict() === null && m.type !== 'ua') return
    // No book on screen: the hidden page's taps, keys, words and selections are not the reader's.
    if (!inBookRef.current && !takenWithoutBook(m.type)) return
    switch (m.type) {
      case 'ua':
        onUserAgent(m.ua)
        return
      case 'ready':
        deadlines.ready()
        call(`window.__fol.insets(${JSON.stringify(safeInsets)})`)
        // A fresh page shows no image (one open in the page it replaced said nothing as it went): back is not held by it.
        setLightbox(false)
        // #1267: the lightbox's words in the reader's language (README, `labels`): the page has no i18n.
        call(`window.__fol.labels(${JSON.stringify({ image: tRef.current('reader.v2.lightboxImage'), close: tRef.current('reader.v2.lightboxClose') })})`)
        // The layout goes in first: injected calls run in order, so the open below uses it.
        Promise.all([storedFlow(), storedPageSettings()]).then(([f, chosen]) => {
          call(`window.__fol.flow(${JSON.stringify(f)})`)
          call(`window.__fol.settings(${JSON.stringify(readSettings(chosen))})`)
          ready.current = true
          // A fresh page holds no words: sent only when there are some.
          marksSent.current = null
          if (vocab.current.length) sendMarks()
          if (reopensOnReady({ opening: opening.current, inBook: inBookRef.current })) open(opening.current!)
          else if (opening.current) endBook() // closed while the page was gone: its book-closed never came
        })
        return
      case 'opened': {
        // A book closed before its page answered: not taken (no restore, so the page saves nothing for it).
        if (!inBookRef.current) return deadlines.answered()
        const t = tracker.opened(m)
        if (t) {
          deadlines.answered()
          strikes.clear()
          pageDir.current = readDir(m) ?? 'ltr'
          // Untrusted: only what readToc takes.
          const entries = readToc(m)
          setToc(entries)
          if (contentsOnOpen.current && entries.length) {
            setTocOpen(true)
            // Shown: a remount of the route opens at the book, not the sheet again.
            router.setParams({ contents: undefined })
          }
          contentsOnOpen.current = false
          takeOpened(t)
        } else console.log(`[v2] opened ${String(m.book?.name)} kept aside or dropped; current is ${opening.current?.file}`)
        return
      }
      case 'described': {
        const d = readDescribed(m)
        if (d) described.current.get(d.id)?.(d.meta ? d : null)
        return
      }
      case 'open-failed': {
        const f = tracker.failed(m.name)
        if (!f) return
        deadlines.answered()
        strikes.clear()
        console.log(`[v2] open-failed ${f.failed.name}: ${m.error}`)
        giveUp(f.failed, hostError(m.error, t))
        // The page kept a book on screen that answered meanwhile: it is the one read now.
        if (f.take) takeOpened(f.take)
        return
      }
      case 'restored':
        // Only for the book taken last: a stale answer must not mark another book restored.
        if (!tracker.restored(m)) return console.log(`[v2] restored for another book dropped`)
        console.log('[v2] restored', JSON.stringify(m))
        place.restored()
        return
      case 'store':
        // Then the notes again: a highlight just made has its row now (#1312 review).
        readerStorage().writeStore(m.key, m.json).then(() => {
          syncSoon()
          // Not on every page turn: only after the page listed a changed highlight set.
          if (notesStale.current) refreshNotes()
          notesStale.current = false
        }, fail('store', showError(t('reader.v2.failed.store'))))
        return
      case BOOK_CLOSED:
        // The reader route's Back (#1361): the save is in, now leave.
        if (leaving.current) return leave()
        // The closed book's pending save came first (CLOSE_BOOK_JS); a reopen meanwhile keeps it.
        if (!inBookRef.current) endBook()
        return
      case 'relocate': {
        // What the chrome shows and follows is read through readRelocate (the page renders untrusted content).
        const shown = readRelocate(m)
        // The reader moving the place (the page's `moved`), in either flow, hides the bars; not under a bar button.
        if (hidesBarsOnRelocate({ moved: !!shown?.moved, msSinceHostMove: hostMoves.onRelocate(Date.now()) }) && effectiveFlow !== 'scrolled' && Date.now() - manualBarsAt.current > 600) hideBars()
        pageDir.current = shown?.dir ?? pageDir.current
        // The reader moved the place: a word popup's word left it (the toolbar follows the page's selection messages).
        if (shown?.moved) onPopupEvent({ type: 'moved' })
        place.relocate(shown)
        // Not after a failed open, until the next open (openTracker.mjs showsPosition: the rule and its cost).
        if (!tracker.showsPosition()) return
        if (!shown) return
        sessions.relocate(shown, Date.now())
        tocIndex.current = shown.tocIndex
        setProgress.current({ fraction: shown.fraction, index: shown.index, sections: shown.sections, toc: shown.toc, tocIndex: shown.tocIndex, sectionEnd: shown.sectionEnd, words: shown.words })
        setAtEnd(shown.atEnd)
        // Untrusted, as the rest: only what readChapterEnd takes.
        setChapterEnd(readChapterEnd(m))
        return
      }
      case 'chapter-end':
        // #1316: the chapter end of the place last reported, known only now. Not after a failed open, as its relocate.
        if (tracker.showsPosition()) setChapterEnd(readChapterEnd(m))
        return
      case 'chapter-text':
        // #1316: the page's answer to this host's own request (an id it made); anything else is dropped.
        discuss.answer(readChapterText(m))
        return
      case 'word': {
        // Untrusted (the page renders the book): only what readWord takes.
        const w = readWord(m)
        if (!w) return
        sessions.activity(Date.now())
        // Mobile: short taps navigate; native selection (hold/drag) is the only translation gesture.
        onPopupEvent({ type: 'tap', x: w.rect.x + w.rect.w / 2 })
        return
      }
      case 'reader-scroll': {
        const position = readReaderScroll(m)
        if (!position || effectiveFlow !== 'scrolled') return
        const now = Date.now()
        const navigating = !hidesBarsOnRelocate({ moved: true, msSinceHostMove: hostMoves.onRelocate(now) })
        const action = scrollIntent.current.move(position, navigating || !!popupRef.current || now - manualBarsAt.current < 600)
        if (action === 'show') showBars()
        if (action === 'hide') hideBars()
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
      case 'highlight-list': {
        // #1312, untrusted: only what readHighlightList takes; a previous book's is dropped.
        const l = readHighlightList(m)
        if (!l || !isOpenKey(l.key)) return
        setHighlightList(l.highlights)
        // A highlight just made: its row is stored with the `store` that follows; the notes are read then. Never read yet
        // (two failed reads): tried again now.
        notesStale.current = true
        if (!notesRead.current) refreshNotes()
        const pending = pendingHighlight.current
        const want = pending && l.highlights.find((h) => readerStorage().realId(h.id) === readerStorage().realId(pending))
        if (want) {
          pendingHighlight.current = null
          goHighlight(want)
        }
        return
      }
      case 'bookmark-list': {
        // #1314, untrusted: only what readBookmarkList takes; a previous book's is dropped.
        const l = readBookmarkList(m)
        if (l && isOpenKey(l.key)) setBookmarks(l)
        return
      }
      case 'search-results': {
        // #1315, untrusted: only what readSearchResults takes; a previous book's or an older search's is dropped.
        const r = readSearchResults(m)
        if (!r || !isOpenKey(r.key)) return
        searchRef.current = searchTake(searchRef.current, r)
        renderSearch(searchRef.current.done)
        return
      }
      case 'highlight-tap': {
        // Its editor (colours, note, delete), by the word's edge rule (popupStep).
        const h = readHighlightTap(m)
        if (h) onPopupEvent({ type: 'highlight', highlight: h })
        return
      }
      case 'highlight-removed': {
        // Deleted here at once, the tombstone queued for the server (localLibrary `removeHighlight`).
        const r = readHighlightRemoved(m)
        if (!r || !isOpenKey(r.key)) return
        readerStorage().removeHighlight(r.id).then((done) => {
          // Not held here (already removed, or never stored): said, never silent.
          if (!done) console.warn(`[v2] highlight ${r.id} not removed here: not held, or removed already`)
          refreshNotes()
          syncSoon()
        }, fail('remove highlight', showError(t('reader.v2.failed.removeHighlight'))))
        return
      }
      case 'tap': {
        const p = readTap(m)
        if (!p) return
        sessions.activity(Date.now())
        onPopupEvent({ type: 'tap', x: p.x })
        return
      }
      case 'key': {
        // A navigation key pressed in the page (#1263), through readKey: one press, one turn (a held key's
        // repeats are dropped). A turn hides the bars, as an edge tap does; Escape ('bars') shows them.
        const k = readKey(m)
        if (k) sessions.activity(Date.now())
        // #1269: Escape with the word popup or toolbar open closes it and does nothing else.
        if (k?.key === 'Escape' && popupRef.current) return closePopup()
        if (!k || k.repeat) return
        const a = keyAction({ ...k, dir: pageDir.current })
        if (a === 'bars') showBars()
        else if (a) {
          call(`window.__fol.${a}()`)
          hideBars()
        }
        return
      }
      case 'lightbox': {
        // #1265: an image tapped in the page (never a `tap` or `word`): what was open closes, the bars hide while it shows.
        const shown = readLightbox(m)
        if (shown === null) return
        setLightbox(shown)
        if (shown) {
          closePopup()
          hideBars()
        }
        return
      }
      case 'openLink':
        if (/^https?:\/\//i.test(m.href)) Linking.openURL(m.href).catch(fail('openLink'))
        return
      case 'telemetry':
        // TODO(#1128): the app has no analytics pipeline yet (lib/sentry.ts: no telemetry is sent);
        // this event plugs in where one lands, after the Play Data Safety list is reviewed for it.
        console.log('[v2] telemetry', JSON.stringify(m))
        return
      case 'log':
        console.log(`[v2 page] ${m.level}: ${m.msg}`)
    }
  }

  /**
   * Finish book (#1266): local first (no token, no network), then the outbox carries it. The open book is found
   * by its bytes, so a re-key by a sync while it is read still finishes it. `flushPage()` only asks the page for
   * its pending save: that `store` comes back as a message after this write, and is queued again when it lands.
   * The completion goes with whatever place is stored when the push runs, and the flushed place follows on the
   * next pass, still carrying `completedAt` (sent with every write while it stands).
   */
  const openBook = openSha ? books.find((b) => b.local && b.sha256 === openSha) : undefined
  /** The chapter whose run found no assistant connected: its connect sheet shows. */
  const connecting = Object.entries(discussStates).find(([, st]) => st.phase === 'connect')?.[0] ?? null
  const finishBook = () => {
    const sha = openShaRef.current
    if (!sha) return
    flushPage()
    readerStorage().finishBook(sha).then((list) => {
      setBooks(list)
      sync.current()
    }, fail('finish book', showError(t('reader.v2.failed.finishBook'))))
  }
  // Applied live: the page re-lays the book out where it is (README, `settings`). Before `ready` the pending
  // ready handler applies the stored choices instead.
  useEffect(() => {
    if (ready.current) call(`window.__fol.settings(${JSON.stringify(settings)})`)
  }, [settings])

  const changeFlow = (next: Flow) => {
    if (!flow || !reflowable || next === flow) return
    setFlow(next)
    flowChoice = Promise.resolve(next)
    AsyncStorage.setItem(FLOW_KEY, next).catch(fail('flow'))
    // The live view switches in place: no reload, the position stays (README, flow). Before `ready`
    // the pending ready handler applies storedFlow() instead.
    if (ready.current) call(`window.__fol.flow(${JSON.stringify(next)})`)
  }
  const toggleFlow = () => changeFlow(flow === 'paginated' ? 'scrolled' : 'paginated')

  /** A new page load: not ready until it says so, and no lightbox (#1265: the old page's went with it, unannounced). */
  function newPage() {
    ready.current = false
    setLightbox(false)
    setNonce(freshNonce())
  }

  // A page that is gone is a new load: a new nonce, and the open starts again from `ready`. The second
  // crash while the same book is open stops that: it is not reopened, and the reader is told why.
  const reload = useCallback(() => {
    const o = opening.current
    // Only a book on screen counts a crash; a closed one is ended on the next `ready`.
    if (o && inBookRef.current) {
      const again = crashedFile.current === o.file
      crashedFile.current = again ? null : o.file
      if (again) giveUp(o, tRef.current('reader.v2.crashes'))
    }
    newPage()
  }, [])

  // Every page load (first mount, a crash reload, Retry) owes a `ready`: on a WebView too old for the page
  // nothing else would ever say so (#1080 item 3; the `ua` answer keeps a known-old WebView out, this catches an unknown one).
  useEffect(() => {
    deadlines.waitReady(READY_DEADLINE_MS)
    return () => deadlines.dispose()
  }, [nonce])

  // An open overdue twice in a row (Retry sent it again) is given up as a crashing book is: dropped with its
  // staged file, the reader told; a new page load stops the page still working on it.
  useEffect(() => {
    if (overdue !== 'opened') return
    const o = opening.current
    if (!o || !strikes.strike(o.file)) return
    giveUp(o, tRef.current('reader.v2.openedLateTwice'))
    newPage()
  }, [overdue])

  /** Retry after a deadline: a new page load; the open in flight (its file is still on disk) goes again on `ready`. */
  const retry = () => newPage()

  // Android back: the offer, the lightbox, the popup, then the book (back to the list), then the route (chrome.mjs backAction).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const action = backAction({ offer: !!offer, lightbox, ready: ready.current, popup: !!popup, reading: inBook })
      if (action === 'close-offer') setOffer(null)
      else if (action === 'close-lightbox') call('window.__fol.closeLightbox()')
      else if (action === 'close-popup') closePopup()
      else if (action === 'close-book') closeBook()
      return action !== 'leave'
    })
    return () => sub.remove()
  }, [offer, lightbox, popup, inBook])

  /** The highlight a tap opened (#1312), as the page lists it; none: no editor. */
  const tapped = popup?.kind === 'highlight' ? highlightList.find((h) => h.id === popup.id) : undefined
  // Tombstoned while drawn (a pull, another device): it leaves the page and its list, and an editor on it closes (#1312 review).
  useEffect(() => {
    for (const h of highlightList) {
      if (!notes?.deleted.has(h.id)) continue
      call(`window.__fol.removeHighlight(${JSON.stringify(h.id)})`)
      if (popupRef.current?.kind === 'highlight' && popupRef.current.id === h.id) setPopup(null)
    }
    // #1314: a bookmark too (the same rows).
    for (const b of bookmarks?.bookmarks ?? []) if (notes?.deleted.has(b.id)) call(`window.__fol.removeBookmark(${JSON.stringify(b.id)})`)
  }, [notes, highlightList, bookmarks])

  // #1312: the dev route's deep link (the highlights screen): the book, opened once, then the highlight.
  // M5 (#1031): the reader route names it `bookId`; a book only the server has is downloaded first (its highlight link
  // is then dropped by that open). Not in the library after a sync pass, or its download failed: an error with Retry.
  const linked = useRef(false)
  const [linkFailed, setLinkFailed] = useState(false)
  useEffect(() => {
    linked.current = false
    setLinkFailed(false)
  }, [linkedBook])
  useEffect(() => {
    if (linked.current || !linkedBook) return
    const b = books.find((x) => x.id === linkedBook)
    if (!b) {
      if (syncPasses > 0) setLinkFailed(true)
      return
    }
    linked.current = true
    setLinkFailed(false)
    // Before the download path returns: its open takes it too.
    contentsOnOpen.current = params.contents === '1'
    // This device opened it: "Recently opened" sorts it first, with no server write (a reopen moves no place).
    AsyncStorage.getItem(OPENED_AT_KEY).then((j) => AsyncStorage.setItem(OPENED_AT_KEY, withOpened(j, b.id))).catch(() => {})
    if (!b.local) {
      download(b).then((ok) => { if (!ok) setLinkFailed(true) })
      return
    }
    open({ file: bookFile(b.sha256), name: b.originalName, format: b.format })
    // After `open`, which clears any earlier one.
    pendingHighlight.current = typeof params.highlight === 'string' ? params.highlight : null
  }, [books, linkedBook, syncPasses])
  const retryLink = () => {
    linked.current = false
    setLinkFailed(false)
    sync.current()
  }

  /** What translate and explain read the book as: its own language, else the app's (the legacy reader's rule). */
  const textLang = readerTextLanguage(bookLang, language)
  // A book whose language does not read (savesWords) marks and fills none: its words would be another language's.
  vocabLang.current = langSaves ? textLang : null
  useEffect(() => { sendMarks() }, [textLang, langSaves])
  /** The bar's ✓ (and Remove's card id): the word is one of the book's language's rows (saved here or anywhere, pulled or answered). */
  const savedKeys = useMemo(() => new Map(forBook(vocabRows, vocabLang.current).map((w) => [vocabMapKey(w.word), w.id])), [vocabRows, langSaves, textLang])
  /** The saved card the bar is about: a tapped word, or a selection that is exactly one saved word (a long-press). */
  const savedIdOf = (p: Popup) =>
    p.kind === 'word' ? savedKeys.get(vocabMapKey(p.word)) : p.kind === 'selection' ? savedKeys.get(vocabMapKey(p.text.trim())) : undefined
  // #1271: missing translations filled once per (open, user, native language) — `vocabOpen` is bumped by an open and by a
  // user change — over the book's language's rows without one (the legacy readers' backfill). Each one the server took is
  // written to its row; the rows are read again, coalesced. Stopped by a new open, a user change, a new native language
  // (it restarts for what is still missing) and the screen going.
  useEffect(() => {
    if (!vocabOpen) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let gone = false
    const ctx = writeContext()
    void backfillTranslations(backfillable(vocab.current, vocabLang.current, filling.current), vocabLang.current, nativeLanguage, {
      translate: (w) => cachedTranslate(w, textLang, nativeLanguage).then((r) => r.translation || null),
      // The card the server answers with (`onlyIfEmpty` keeps a translation it had): its translation goes to the row.
      persist: (id, tr) => vocabularyApi.updateWord(id, { translation: tr, onlyIfEmpty: true }).then(async (card) => {
        const kept = serverTranslation(card)
        if (gone || !kept || ctx.asker !== vocabUser.current) return
        await deviceLocalLibrary().setWordTranslation(id, kept, ctx.guard)
        clearTimeout(timer)
        timer = setTimeout(() => { if (!gone) refreshVocab() }, 300)
      }),
      onWord: () => {},
      cancelled: () => gone || vocabOpen !== vocabEpoch.current,
    })
    return () => { gone = true; clearTimeout(timer) }
  }, [vocabOpen, nativeLanguage])
  const button = [styles.button, { backgroundColor: colors.primary }]
  const notices = (
    <>
      {overdue && (
        <View style={styles.alert} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Text style={[styles.meta, { color: colors.error }]}>
            {overdue === 'opened'
              ? fill(t('reader.v2.openTimeout'), { name: opening.current?.name ?? t('reader.v2.theBook') })
              : verdict === 'ok' ? t('reader.v2.frameFailed') : t('updates.webView.readyFailed')}
          </Text>
          <Pressable onPress={retry} accessibilityRole="button" style={button}><Text style={styles.buttonText}>{t('common.retry')}</Text></Pressable>
        </View>
      )}
      {linkFailed && (
        <View>
          <Text style={[styles.meta, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">{t('reader.v2.linkFailed')}</Text>
          <Pressable onPress={retryLink} accessibilityRole="button" style={button}><Text style={styles.buttonText}>{t('common.retry')}</Text></Pressable>
        </View>
      )}
      {/* One error per failed deep link: its own (with Retry) over the download's. */}
      {openError && !linkFailed && <Text style={[styles.meta, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">{openError}</Text>}
      {error && <Text style={[styles.meta, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
      {offer && (
        <Pressable onPress={() => { goTo(offer, true); setOffer(null) }} accessibilityRole="button" style={styles.offer}>
          <Text style={[styles.meta, { color: colors.primary }]}>{fill(t('reader.v2.newerPlace'), { percent: Math.round((offer.fraction ?? 0) * 100) })}</Text>
        </Pressable>
      )}
    </>
  )
  const hasNotices = !!(overdue || linkFailed || openError || error || offer)
  const dismissNotices = () => {
    setLinkFailed(false)
    setError(null)
    setOpenError(null)
    setOffer(null)
  }
  return (
    <View style={[styles.screen, { backgroundColor: inBook ? theme.bg : colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden={inBook && !barsVisible} style={(inBook ? settings.theme === 'dark' : isDark) ? 'light' : 'dark'} />
      <View
        // No book on screen: the list covers the page, and TalkBack must not reach the book behind it.
        importantForAccessibility={inBook ? 'auto' : 'no-hide-descendants'}
        accessibilityElementsHidden={!inBook}
        style={styles.page}
      >
        <WebView
          key={nonce}
          ref={webView}
          style={styles.page}
          // No system Copy/Share/Web search menu over our bar (the legacy reader's ReaderShell did the same).
          menuItems={[]}
          onLayout={(e) => { pageWidth.current = e.nativeEvent.layout.width }}
          // README "WebView": the shared security props (pageWebView.ts).
          {...PAGE_WEBVIEW_PROPS}
          source={source}
          onMessage={onMessage}
          // Runs as its own script on page start, so it answers even where the page fails to parse (#1228).
          injectedJavaScriptBeforeContentLoaded={USER_AGENT_PROBE}
          onRenderProcessGone={reload}
          onContentProcessDidTerminate={reload}
        />
      </View>
      {inBook ? (
        <>
          {/* #1267 review: the image lightbox covers the screen: the bars are out of TalkBack's reach meanwhile. */}
          <ReaderTopBar
            hiddenFromAccessibility={lightbox}
            barBg={theme.bg}
            barText={theme.fg}
            onSettingsPress={() => setSettingsOpen(true)}
            barsAnim={barsAnim}
            topBarTranslateY={topBarTranslateY}
            barsVisible={barsVisible}
            topInset={insets.top}
            bookTitle={heading}
            chapterTitle=""
            sessionWordCount={0}
            // Gates only the bookmarks and highlights buttons: neither list needs an account (the reading path never
            // does, #1312 review).
            isAuthenticated
            hasChapters={toc.length > 0}
            onTocPress={() => setTocOpen(true)}
            onHighlightsPress={annotatable ? () => setHighlightsOpen(true) : undefined}
            // #1314: where a bookmark can be made in this book (the page's `bookmarkable`), or it holds some already
            // (made elsewhere): never an empty sheet that invites what cannot be done. Filled while the place being
            // read has one.
            onBookmarksPress={bookmarkable || bookmarks?.bookmarks.length ? () => setBookmarksOpen(true) : undefined}
            onSearchPress={search.searchable ? () => setSearchOpen(true) : undefined}
            tocLabel={t('reader.chrome.contents')}
            isCurrentBookmarked={!!bookmarks?.here}
            onExit={closeBook}
            backLabel={t('reader.chrome.back')}
          />
          <PlaceFooter
            hiddenFromAccessibility={lightbox}
            setter={setProgress}
            toc={toc}
            onGoToc={goToc}
            barBg={theme.bg}
            barText={theme.fg}
            trackColor={theme.fg + '22'}
            barsAnim={barsAnim}
            footerTranslateY={footerTranslateY}
            barsVisible={barsVisible}
            bottomInset={insets.bottom}
            onPrev={() => barTurn('prev')}
            onNext={() => barTurn('next')}
            prevLabel={t('reader.chrome.prevPage')}
            nextLabel={t('reader.chrome.nextPage')}
            onHeight={(h) => { if (h > 0 && h !== footerHeight) setFooterHeight(h) }}
          />
          {/* Not over the image lightbox (#1267 review): the write is local, nothing is in flight to keep. */}
          {openBook && !lightbox && showsFinishBook({ atEnd, format }) && (
            <FinishBook
              finished={openBook.finished}
              onFinish={finishBook}
              bottom={(barsVisible ? footerHeight || 60 + insets.bottom : insets.bottom) + 12}
              background={colors.background}
              color={colors.text}
              accent={colors.primary}
              finishLabel={t('reader.chrome.finishBook')}
              finishedLabel={t('reader.chrome.finished')}
            />
          )}
          {/* #1316: with a session only (the share is the account's); above the finish pill when both show. */}
          {openBook && !lightbox && userId && chapterEnd && offersDiscuss(chapterEnd) && (
            <ChapterDiscuss
              key={chapterKey(chapterEnd)}
              title={chapterEnd.title}
              state={discussStates[chapterKey(chapterEnd)]}
              onShare={() => { void discussChapter(chapterEnd) }}
              onOpen={() => { const st = discussStates[chapterKey(chapterEnd)]; if (st?.phase === 'ready') void openChat(st.shared, st.grants) }}
              bottom={(barsVisible ? footerHeight || 60 + insets.bottom : insets.bottom) + 12 + (showsFinishBook({ atEnd, format }) ? 56 : 0)}
              background={colors.background}
              color={colors.text}
              accent={colors.primary}
              labels={{
                start: t('reader.v2.discuss.start'), startTitled: t('reader.v2.discuss.startTitled'), sharing: t('reader.v2.discuss.sharing'),
                shared: t('reader.v2.discuss.shared'), cut: t('reader.v2.discuss.cut'), open: t('reader.v2.discuss.open'), retry: t('reader.v2.discuss.retry'),
                empty: t('reader.v2.discuss.empty'), unavailable: t('reader.v2.discuss.unavailable'), offline: t('reader.v2.discuss.offline'),
                signedOut: t('reader.v2.discuss.signedOut'), noBook: t('reader.v2.discuss.noBook'), timeout: t('reader.v2.discuss.timeout'), failed: t('reader.v2.discuss.failed'),
              }}
            />
          )}
          {/* No assistant connected (a run's `connect`): nothing was shared; closed, the chapter's pill is idle again. */}
          <ConnectAssistantSheet visible={connecting !== null} onClose={() => { if (connecting !== null) setDiscussStates(({ [connecting]: _, ...rest }) => rest) }} />
          {popup && popup.kind !== 'highlight' && (
            // The legacy reader's bar (#1269): the word's gloss (or the picker's line) on a tap; on a selection highlight,
            // copy, translate, explain; Save on a word (#1270); Listen (#1272). Nothing here needs the network to
            // read on: a failed gloss says so, the sheets and a failed save show their own errors.
            <SelectionActionBar
              selectedText={popup.kind === 'word' ? popup.word : popup.text}
              sentence={popup.sentence}
              language={textLang}
              onTranslate={() => setSheet({ kind: 'translate', text: popup.kind === 'word' ? popup.word : popup.text, sentence: popup.sentence })}
              onExplain={() => setSheet({ kind: 'explain', text: popup.kind === 'word' ? popup.word : popup.text, sentence: popup.sentence })}
              // The legacy bar: the last colour chosen (a recolour in the editor sets it for the next).
              highlightColor={highlightColor}
              onHighlight={popup.kind === 'selection' && annotatable ? (c) => { call(`window.__fol.highlightSelection(${JSON.stringify(colorOf(c))})`); setPopup(null) } : undefined}
              tooLong={popup.kind === 'selection' && popup.tooLong}
              onSpeak={ttsLanguage && ttsHasVoice(ttsLanguage) ? () => listener.press(spokenOf(popup)) : undefined}
              isSpeaking={listener.state(spokenOf(popup)) === 'playing'}
              isTtsLoading={listener.state(spokenOf(popup)) === 'loading'}
              isAuthenticated={!!user}
              // No Save where the book's language does not read (savesWords): the gloss still uses the fallback.
              onSaveWord={langSaves ? (translation) => { void saveWord(popup, translation) } : undefined}
              onSaveQuote={popup.kind === 'selection' && annotatable && popup.cfi ? () => { call('window.__fol.saveQuotation()'); setPopup(null) } : undefined}
              wordSaved={!!savedIdOf(popup)}
              onRemove={savedIdOf(popup) ? () => { removeWord(popup, savedIdOf(popup)!) } : undefined}
              bottomOffset={barsVisible ? footerHeight : insets.bottom}
              onClose={closePopup}
              onCopy={closePopup}
            />
          )}
          <TranslationSheet
            visible={sheet?.kind === 'translate'}
            text={sheet?.text ?? ''}
            sentence={sheet?.sentence}
            fromLang={textLang}
            onClose={closeSheet}
          />
          <ExplanationSheet
            visible={sheet?.kind === 'explain'}
            word={sheet?.text ?? ''}
            sentence={sheet?.sentence || sheet?.text || ''}
            fromLang={textLang}
            onClose={closeSheet}
          />
          <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onUpdate={updateSettings} typography={reflowable} flow={flow} onFlowChange={changeFlow} ttsSpeed={ttsSpeed} onTtsSpeed={updateTtsSpeed}
            glosses={annotatable ? { on: legacySettings.showInlineTranslations, onChange: (on) => updateLegacySettings({ showInlineTranslations: on }) } : undefined} />
          <TocSheet visible={tocOpen} toc={toc} tocIndex={tocIndex.current} onGo={goToc} onClose={() => setTocOpen(false)} />
          <BookmarksSheet
            visible={bookmarksOpen}
            items={bookmarks?.bookmarks ?? []}
            here={bookmarks?.here ?? null}
            can={bookmarks?.can ?? false}
            placing={!bookmarks || bookmarks.placing}
            onToggle={toggleBookmark}
            onGo={goHighlight}
            onRemove={(id) => call(`window.__fol.removeBookmark(${JSON.stringify(id)})`)}
            onClose={() => setBookmarksOpen(false)}
          />
          <SearchSheet key={searchBook} visible={searchOpen} search={search} onQuery={askSearch} onGo={goHighlight} onClose={() => setSearchOpen(false)} />
          <HighlightsSheet visible={highlightsOpen} items={highlightList} noteOf={(id) => notes?.known.get(id) ?? null} onGo={goHighlight} onClose={() => setHighlightsOpen(false)} />
          {popup?.kind === 'highlight' && tapped && (
            // #1312: the legacy editor. A colour is one tap (the page redraws and saves it); Save is the note (here,
            // queued; a draft unchanged from the note it was typed over writes nothing); Delete goes through the page,
            // which answers `highlight-removed`. Keyed: another highlight is a fresh editor. Until its note is known (a
            // row from before notes, not pulled yet) the field waits and Save is off; untouched, it follows the note.
            <HighlightNoteModal
              key={editorOpening.current}
              visible
              snippet={tapped.text}
              // Loading until this open's notes are read, or while its row's note is not known; an id with no row is new.
              noteLoading={!notes || notes.unknown.has(tapped.id)}
              initialNote={notes?.known.get(tapped.id) ?? null}
              initialColor={tapped.color}
              onCancel={() => setPopup(null)}
              onColorChange={(c) => {
                call(`window.__fol.recolorHighlight(${JSON.stringify(tapped.id)}, ${JSON.stringify(colorOf(c))})`)
                chooseColor(colorOf(c))
              }}
              onSave={(text, base) => {
                setPopup(null)
                const note = noteChange(text, base)
                if (note === undefined) return
                readerStorage().setNote(tapped.id, note).then((done) => {
                  // Gone meanwhile (removed, or not held here): said, the editor is already closed, the notes read again.
                  if (!done) console.warn(`[v2] note not saved: highlight ${tapped.id} is not held here`)
                  refreshNotes()
                  syncSoon()
                }, fail('note', showError(t('reader.v2.failed.note'))))
              }}
              onDelete={() => {
                call(`window.__fol.removeHighlight(${JSON.stringify(tapped.id)})`)
                setPopup(null)
              }}
            />
          )}
          {hasNotices && (
            <View style={[styles.notices, { top: barsVisible ? 56 + insets.top : insets.top, backgroundColor: colors.background }]}>
              <View style={styles.noticesText}>{notices}</View>
              {!overdue && (
                <Pressable onPress={dismissNotices} accessibilityRole="button" accessibilityLabel={t('reader.chrome.dismiss')} style={styles.dismiss}>
                  <Text style={[styles.dismissText, { color: colors.text }]}>×</Text>
                </Pressable>
              )}
            </View>
          )}
        </>
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.bar}>
            <Pressable onPress={pick} accessibilityRole="button" style={button}><Text style={styles.buttonText}>{t('reader.v2.pickBook')}</Text></Pressable>
            <Pressable onPress={toggleFlow} accessibilityRole="button" disabled={!flow || !reflowable} style={[button, (!flow || !reflowable) && styles.disabled]}><Text style={styles.buttonText}>{t(flow === 'paginated' ? 'reader.v2.scrolled' : 'reader.v2.paginated')}</Text></Pressable>
            {userId && (
              <Pressable onPress={toggleFileSync} accessibilityRole="button" style={button}><Text style={styles.buttonText}>{t(fileSync ? 'reader.v2.filesSync' : 'reader.v2.filesLocal')}</Text></Pressable>
            )}
          </View>
          <Text style={[styles.heading, { color: colors.text }]} numberOfLines={1}>{heading || t('reader.v2.pick')}</Text>
          {copying > 0 && <Text style={[styles.meta, { color: colors.textSecondary }]} accessibilityLiveRegion="polite">{t('reader.v2.copying')}</Text>}
          {notices}
          {books.length > 0 && (
            <ScrollView horizontal style={styles.books} contentContainerStyle={styles.booksRow}>
              {books.map((b) => (
                <Pressable
                  key={b.id}
                  onPress={() => (b.local ? open({ file: bookFile(b.sha256), name: b.originalName, format: b.format }) : download(b))}
                  accessibilityRole="button"
                  style={[styles.book, { borderColor: colors.border }]}
                >
                  <Text numberOfLines={1} style={[styles.meta, { color: colors.textSecondary }]}>{b.local ? b.title : `↓ ${b.title}`}</Text>
                  {b.finished && <Text style={[styles.meta, { color: colors.primary }]}>{t('reader.chrome.finished')}</Text>}
                  {b.notSynced && (
                    <>
                      <Text numberOfLines={2} style={[styles.meta, { color: colors.error }]}>{fill(t('reader.v2.notSynced'), { reason: b.notSynced })}</Text>
                      <Pressable onPress={() => unpark(b)} accessibilityRole="button">
                        <Text style={[styles.meta, { color: colors.primary }]}>{t('common.retry')}</Text>
                      </Pressable>
                    </>
                  )}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { flexDirection: 'row', gap: 8, padding: 8 },
  button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6 },
  buttonText: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.4 },
  offer: { paddingHorizontal: 8, paddingVertical: 4 },
  alert: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
  heading: { paddingHorizontal: 8, fontSize: 15, fontWeight: '600' },
  meta: { paddingHorizontal: 8, fontSize: 12 },
  books: { flexGrow: 0, paddingVertical: 4 },
  booksRow: { gap: 6, paddingHorizontal: 8 },
  book: { borderWidth: 1, borderRadius: 6, paddingVertical: 4, maxWidth: 160 },
  page: { flex: 1 },
  notices: { position: 'absolute', left: 0, right: 0, zIndex: 11, paddingVertical: 4, flexDirection: 'row', alignItems: 'flex-start' },
  noticesText: { flex: 1 },
  dismiss: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  dismissText: { fontSize: 22 },
  update: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  updateText: { alignItems: 'center', gap: 14 },
  updateTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  updateBody: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
})
