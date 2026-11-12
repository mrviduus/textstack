import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import { uuid } from 'expo-modules-core'
import type { OpenReader, PagePosition, V2ClientFormat } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useAuth } from '../../context/AuthContext'
import { APP_HEADERS, freshAccessToken } from '../../lib/api'
import { deviceUploadIo, sha256Of, uploadV2Book } from '../../lib/v2'
import { bookFile, createV2Storage, nonceFromUuid, type LibraryBook, type V2Files, type V2Storage } from '../../lib/v2reader/hostStorage'
import { deviceLocalLibrary } from '../../lib/v2reader/deviceLibrary'
import type { BookRow, PositionAction } from '../../lib/v2reader/localLibrary'
import { downloadV2Book, syncV2Library, tryAgainV2Book, type SyncHost } from '../../lib/v2reader/sync'
import { v2ReaderAndroidPageHtml } from '../../lib/v2reader/v2ReaderPage.generated'
import { createOpenTracker, type Take } from '../../lib/v2reader/openTracker.mjs'
import { createDeadlines, createOverdueStrikes, READY_DEADLINE_MS, type Overdue } from '../../lib/v2reader/deadlines.mjs'
import { hostError } from '../../lib/v2reader/hostErrors'
import { readSelection } from '../../lib/v2reader/selection.mjs'
import { readDir, readKey, readTap } from '../../lib/v2reader/chrome.mjs'
import { PAGE_URL, bookUrl } from '../../lib/v2reader/bookOrigin.mjs'
import { useLanguage } from '../../context/LanguageContext'
import { openPlayStorePage } from '../../lib/playStore'
import { USER_AGENT_PROBE, createWebViewCheck, webViewStorePackage, type WebViewVerdict } from '../../lib/v2reader/webViewVersion'

/**
 * The V2 reader (ADR-029) on Android, dev builds only: reached through `app/dev/epub-v2.tsx`.
 * Hosts the generated page and drives the contract in src/lib/v2reader/README.md:
 * ready → openUrl → opened → restore → restored, then store / relocate / word / openLink.
 */

// Built on use: at module scope it threw on the web bundle (expo-file-system web has no paths), which loads every route.
const v2Root = () => new Directory(Paths.document, 'v2')

/** `name` under <documents>/v2/, e.g. `books/<sha256>.epub`. */
const v2File = (name: string) => new File(v2Root(), ...name.split('/'))

function deviceFiles(): V2Files {
  // Anything still staged belongs to an open that never finished in an earlier process.
  const staging = new Directory(v2Root(), 'staging')
  if (staging.exists) staging.delete()
  for (const dir of ['books', 'store', 'staging']) new Directory(v2Root(), dir).create({ intermediates: true, idempotent: true })
  return {
    read: async (name) => {
      const file = v2File(name)
      return file.exists ? file.text() : null
    },
    move: (from, to) => v2File(from).move(v2File(to), { overwrite: true }),
    exists: (name) => v2File(name).exists,
    remove: (name) => {
      const file = v2File(name)
      if (file.exists) file.delete()
    },
    // expo-file-system copies a SAF/content:// source to a local file (Android, since 56.0.0).
    copyIn: (uri, to) => new File(uri).copy(v2File(to)),
  }
}

// One storage for the process, so every read and write goes through its one queue.
let storage: V2Storage | null = null
const v2Storage = () => (storage ??= createV2Storage(deviceFiles(), uuid.v4, deviceLocalLibrary()))

/**
 * File sync (opt-in): the retained copy's bytes through the shared upload sequence, with the format
 * the page reported (the retained name always ends `.epub`) and to the book's KNOWN server ids only.
 */
const uploadRetained: SyncHost['upload'] = async (b: BookRow, maxPartBytes, cancelled) => {
  await uploadV2Book(
    { uri: v2File(bookFile(b.sha256!)).uri, name: b.original_name, format: (b.format ?? undefined) as V2ClientFormat | undefined },
    maxPartBytes,
    deviceUploadIo(cancelled),
    undefined,
    { bookId: b.id, fileId: b.server_file_id!, sha256: b.sha256! },
  )
}

/** Download on demand: into staging, checked against the sha256, then the retained copy (`staging/` is cleared on start). */
const downloadIo = {
  async fetch(url: string, sha256: string) {
    const token = await freshAccessToken()
    const staged = `staging/dl-${Date.now()}.epub`
    const dest = v2File(staged)
    const file = await File.downloadFileAsync(url, dest, { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, idempotent: true })
      .catch((e) => {
        // A failed download (a full disk) leaves no partial file, like a failed pick.
        try { if (dest.exists) dest.delete() } catch { /* staging/ is cleared on start */ }
        throw e
      })
    const source = deviceUploadIo(() => false).open(file.uri)
    const actual = await sha256Of(source, () => new Promise((r) => setTimeout(r, 0))).finally(() => source.close())
    if (actual !== sha256) {
      file.delete()
      throw new Error('downloaded bytes do not match the book')
    }
    return staged
  },
  retain: async (staged: string, sha256: string) => v2File(staged).move(v2File(bookFile(sha256)), { overwrite: true }),
}

/** A sync pass is asked for this long after the last save (the reading path never waits for it). */
const SYNC_AFTER_SAVE_MS = 10_000

/** The reader's layout, a per-user setting (#1128): paginated unless the reader chose scrolled. No legacy preference is migrated. */
type Flow = 'paginated' | 'scrolled'
const FLOW_KEY = 'v2reader.flow'
/**
 * The reader's choice, read once for the process (like v2Storage) and replaced by every toggle: each page
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
type Opening = { file: string; name: string }
const isStaged = (file: string) => file.startsWith('staging/')

/** Logs a failure; `show` also puts it on screen (a full disk as a human message, hostErrors.ts). */
const fail = (what: string, show?: (text: string) => void) => (e: unknown) => {
  console.log(`[v2] ${what} failed: ${e}`)
  show?.(`${what}: ${hostError(e)}`)
}

/** The file's size for its `opened` deadline; unknown (null) gives the floor. */
const sizeOf = (file: string) => {
  try { return v2File(file).size } catch { return null }
}

const IDLE_HEADING = 'Pick a book'

/** The WebView's verdict for the process (#1228, webViewVersion.ts): the reader page's first `ua` answer. */
const webViewCheck = createWebViewCheck()

/**
 * Android only (R2): the page reads its book from a native interceptor (bookOrigin.mjs, a react-native-webview patch)
 * that iOS does not have.
 * A WebView older than the page's floor swaps the reader for the update screen (#1228).
 */
export default function V2ReaderScreen() {
  const [verdict, setVerdict] = useState(webViewCheck.verdict)
  if (Platform.OS !== 'android') return <Text>Android dev route only (R2)</Text>
  if (verdict === 'outdated') return <UpdateWebViewScreen />
  return <V2Reader verdict={verdict} onUserAgent={(ua) => setVerdict(webViewCheck.answer(ua))} />
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

/** Re-renders alone on every `relocate`, not the WebView beside it. */
function ProgressLine({ setter, color }: { setter: MutableRefObject<(text: string) => void>; color: string }) {
  const [text, setText] = useState('')
  useEffect(() => { setter.current = setText }, [setter])
  return <Text style={[styles.meta, { color }]}>{text}</Text>
}

/** `verdict` other than `ok` (no or no readable answer yet): an old WebView is a likely cause of a missed `ready`. */
function V2Reader({ verdict, onUserAgent }: { verdict: WebViewVerdict | null; onUserAgent: (ua: unknown) => void }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const webView = useRef<WebView>(null)
  const [nonce, setNonce] = useState(freshNonce)
  // The base URL arms the patched WebView's book interceptor (bookOrigin.mjs) and gives the page that https origin.
  const source = useMemo(() => ({ html: v2ReaderAndroidPageHtml(nonce), baseUrl: PAGE_URL }), [nonce])
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  /** Which page answer belongs to which open (openTracker.mjs): a book kept on screen, a stale `restored`. */
  const [tracker] = useState(() => createOpenTracker<Opening>())
  const setProgress = useRef<(text: string) => void>(() => {})
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [heading, setHeading] = useState(IDLE_HEADING)
  // null until the stored choice is read: the toggle is off until then, so no toggle can race the read.
  const [flow, setFlow] = useState<Flow | null>(null)
  useEffect(() => { storedFlow().then(setFlow) }, [])
  /** False for a fixed-layout book (CBZ): flow changes nothing there, so the toggle is off. */
  const [reflowable, setReflowable] = useState(true)
  /** The book open at the last renderer crash: one that crashes it twice is not reopened again. */
  const crashedFile = useRef<string | null>(null)
  /**
   * Two lines (#1080 item 6): `openError` is the open's (pick, download, open-failed, a failed import, a crash)
   * and only a new open clears it; `error` is everything else (library, settings, sync, saves), so a later
   * `store` failure never overwrites why the book did not open.
   */
  const [openError, setOpenError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  /** The open book as ADR-019 sees it (R6): restored yet, the first CFI after the restore, the one now. */
  const reading = useRef({ bookId: null as string | null, restored: false, baseline: null as string | null, cfi: null as string | null, index: null as number | null })

  const call = (js: string) => webView.current?.injectJavaScript(`${js};true`)
  const refreshBooks = () => v2Storage().books().then(setBooks, fail('library', setError))
  useEffect(() => {
    refreshBooks()
    deviceLocalLibrary().fileSync().then(setFileSync, fail('settings'))
  }, [])

  /**
   * A programmatic move: the next relocate is the new baseline, not the reader moving. The whole position
   * goes (README, `goTo`): not `chosen` (a sync adopt or move, already stored here) the page saves
   * nothing and takes it as its own; `chosen` (the reader took an offer) it saves where it landed.
   */
  const goTo = (p: PagePosition, chosen = false) => {
    reading.current.baseline = null
    call(`window.__fol.goTo(${JSON.stringify(p)}, ${chosen})`)
  }

  // Opportunistic sync (R6): with a session (a guest's too), on open, after saves, never on the reading path.
  const sync = useRef((_retryFailed?: boolean) => {})
  sync.current = (retryFailed = false) => {
    if (!userId) return
    syncV2Library(deviceLocalLibrary(), {
      userId,
      retryFailed,
      newId: uuid.v4,
      reader: (bookId): OpenReader | null => {
        const r = reading.current
        return r.bookId === bookId ? { restoreApplied: r.restored, moved: r.baseline != null && r.cfi !== r.baseline, index: r.index } : null
      },
      onPosition: (a: PositionAction) => {
        if (reading.current.bookId !== a.bookId) return
        if (a.action === 'prompt') setOffer(a.position)
        else goTo(a.position)
      },
      upload: uploadRetained,
    }).then(refreshBooks, fail('sync'))
  }
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

  const toggleFileSync = () => {
    const next = !fileSync
    setFileSync(next)
    deviceLocalLibrary().setFileSync(next).then(
      () => next && sync.current(),
      (e) => {
        // The setting did not land: the toggle shows what is stored, and the reader is told.
        setFileSync(!next)
        fail('file sync setting', setError)(e)
      },
    )
  }

  /** A book only the server has: fetched on demand, then opened. */
  const download = (b: LibraryBook) => {
    setOpenError(null)
    downloadV2Book(deviceLocalLibrary(), b.id, downloadIo).then(
      async (ok) => {
        if (!ok) return
        await refreshBooks()
        open({ file: bookFile(b.sha256), name: b.originalName })
      },
      fail('download', setOpenError),
    )
  }

  /** "Try again" on a book not synced (sync.ts `tryAgainV2Book`). */
  const unpark = (b: LibraryBook) => {
    setError(null)
    tryAgainV2Book(deviceLocalLibrary(), b.id, refreshBooks, () => sync.current()).catch(fail('unpark', setError))
  }

  const open = (target: Opening) => {
    // The URL first: a name the interceptor would not serve (never one this host makes) is refused before any
    // state moves, as a failed open (its staged file dropped).
    const url = bookUrl(target.file)
    if (!url) {
      if (isStaged(target.file)) v2Storage().dropStaged(target.file).catch(fail('drop'))
      return setOpenError(`cannot open ${target.name}: not a file the reader serves`)
    }
    // A superseded open's staged file is dropped once another book is taken (`takeOpened`): until then the
    // page may still keep that book on screen, if this newer open fails before its swap.
    opening.current = { ...target } // a new object even for the same file: an older onOpened sees it was superseded
    tracker.open(target.file, opening.current)
    reading.current = { bookId: null, restored: false, baseline: null, cfi: null, index: null }
    setOffer(null)
    setOpenError(null)
    setError(null)
    setHeading(`Opening ${target.name}`)
    setProgress.current('')
    if (!ready.current) return
    deadlines.waitOpened(sizeOf(target.file))
    call(`window.__fol.openUrl(${JSON.stringify(url)}, ${JSON.stringify(target.file)})`)
  }

  /** The page's book is `t.open`'s: every other open still pending is over, and its staged file goes. */
  const takeOpened = (t: Take<Opening, any>) => {
    for (const o of t.dropped) if (isStaged(o.file) && o.file !== t.open.file) v2Storage().dropStaged(o.file).catch(fail('drop'))
    opening.current = t.open
    setReflowable(t.opened.reflowable !== false)
    onOpened(t.open, t.opened).catch(fail('opened', setOpenError))
  }

  const pick = async () => {
    try {
      // Any file: the page tells the format by its bytes (EPUB, MOBI/AZW3, FB2, CBZ, PDF) and refuses the rest.
      // No picker cache copy (#1080 items 4–5): a moved cache copy keeps the cache's group, so Android counts the
      // retained book as app cache, and a full disk leaves a partial in cache/DocumentPicker/. stagePicked copies the URI.
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: false })
      if (result.canceled) return
      const asset = result.assets[0]
      open({ file: await v2Storage().stagePicked(asset.uri), name: asset.name })
    } catch (e) {
      fail('pick', setOpenError)(e)
    }
  }

  const onOpened = async (current: Opening, m: { book: { sha256: string; size: number }; format?: string; title: string; author: string }) => {
    const s = v2Storage()
    // A reload or a new pick can replace this open during any await; then this answer stops there.
    const superseded = () => opening.current !== current
    // The page shows this book now: its title before any await, so a failed read below leaves no "Opening …".
    setHeading([m.title || current.name, m.author].filter(Boolean).join(' — '))
    const stored = await s.readStore(m.book.sha256)
    if (superseded()) return
    call(`window.__fol.restore(${JSON.stringify(stored)})`)
    const { retained, bookId, books } = await s.addOpened(
      { ...m.book, title: m.title, author: m.author, originalName: current.name, format: m.format ?? null },
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
    reading.current.bookId = bookId
    sync.current()
  }

  /** An open that ends without a book: dropped with its staged file, the reader told why. */
  function giveUp(o: { file: string; name: string }, reason: string) {
    opening.current = null
    if (isStaged(o.file)) v2Storage().dropStaged(o.file).catch(fail('drop'))
    // The old book may still post a relocate until the page takes up this open (file read + messages in
    // flight); a failure must not leave it standing after open() cleared it (#1168).
    setProgress.current('')
    // Not the previous book's title (#1080 item 6): the error line names this file.
    setHeading(IDLE_HEADING)
    setOpenError(`cannot open ${o.name}: ${reason}`)
  }

  const onMessage = (event: WebViewMessageEvent) => {
    let m: any
    try { m = JSON.parse(event.nativeEvent.data) } catch { return }
    if (!m || typeof m !== 'object') return
    // Until the WebView said what it is, only that answer is taken: on an engine without frame-aware messaging
    // (the patch's fallback bridge) any frame can post, and those engines never get past the update screen.
    if (webViewCheck.verdict() === null && m.type !== 'ua') return
    switch (m.type) {
      case 'ua':
        onUserAgent(m.ua)
        return
      case 'ready':
        deadlines.ready()
        // The layout goes in first: injected calls run in order, so the open below uses it.
        storedFlow().then((f) => {
          call(`window.__fol.flow(${JSON.stringify(f)})`)
          ready.current = true
          if (opening.current) open(opening.current)
        })
        return
      case 'opened': {
        const t = tracker.opened(m)
        if (t) {
          deadlines.answered()
          strikes.clear()
          // The reading direction (#1263): what the page says, through readDir; parsed only, no bars yet.
          console.log(`[v2] opened, dir ${readDir(m) ?? 'ltr'}`)
          takeOpened(t)
        } else console.log(`[v2] opened ${String(m.book?.name)} kept aside or dropped; current is ${opening.current?.file}`)
        return
      }
      case 'open-failed': {
        const f = tracker.failed(m.name)
        if (!f) return
        deadlines.answered()
        strikes.clear()
        console.log(`[v2] open-failed ${f.failed.name}: ${m.error}`)
        giveUp(f.failed, hostError(m.error))
        // The page kept a book on screen that answered meanwhile: it is the one read now.
        if (f.take) takeOpened(f.take)
        return
      }
      case 'restored':
        // Only for the book taken last: a stale answer must not mark another book restored.
        if (!tracker.restored(m)) return console.log(`[v2] restored for another book dropped`)
        console.log('[v2] restored', JSON.stringify(m))
        reading.current.restored = true
        reading.current.baseline = null
        setProgress.current(`restore: ${m.position}`)
        return
      case 'store':
        v2Storage().writeStore(m.key, m.json).then(syncSoon, fail('store', setError))
        return
      case 'relocate':
        if (reading.current.restored) {
          reading.current.baseline ??= m.cfi ?? null
          reading.current.cfi = m.cfi ?? null
          reading.current.index = m.index ?? null
        }
        // Not after a failed open, until the next open (openTracker.mjs showsPosition: the rule and its cost).
        if (!tracker.showsPosition()) return
        setProgress.current(`${Math.round((m.fraction ?? 0) * 100)}% · section ${(m.index ?? 0) + 1}/${m.sections ?? '?'}${m.toc ? ` · ${m.toc}` : ''}`)
        return
      case 'word':
        // Translation is not this slice: the tap reaches the host and stops here. This host offers no
        // highlight or translation yet, so `opened.annotatable` (false: CBZ, PDF) has nothing to hide here.
        console.log('[v2] word', m.word)
        return
      case 'selection': {
        // Untrusted (the page renders the book): only what readSelection takes; a malformed one is dropped.
        // No toolbar in this slice (#1268): the selection reaches the host and stops here.
        const s = readSelection(m)
        if (s) console.log(`[v2] selection ${s.text.length} chars, section ${s.index}`)
        return
      }
      case 'tap': {
        // Where it landed (#1263), through readTap; no tap zones yet.
        const p = readTap(m)
        if (p) console.log(`[v2] tap ${p.x},${p.y}`)
        return
      }
      case 'key': {
        // A navigation key pressed in a section (#1263), through readKey; nothing acts on it yet.
        const k = readKey(m)
        if (k) console.log(`[v2] key ${k.key}${k.shift ? ' +shift' : ''}`)
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

  const toggleFlow = () => {
    if (!flow) return
    const next: Flow = flow === 'paginated' ? 'scrolled' : 'paginated'
    setFlow(next)
    flowChoice = Promise.resolve(next)
    AsyncStorage.setItem(FLOW_KEY, next).catch(fail('flow'))
    // The live view switches in place: no reload, the position stays (README, flow). Before `ready`
    // the pending ready handler applies storedFlow() instead.
    if (ready.current) call(`window.__fol.flow(${JSON.stringify(next)})`)
  }

  // A page that is gone is a new load: a new nonce, and the open starts again from `ready`. The second
  // crash while the same book is open stops that: it is not reopened, and the reader is told why.
  const reload = useCallback(() => {
    ready.current = false
    const o = opening.current
    if (o) {
      const again = crashedFile.current === o.file
      crashedFile.current = again ? null : o.file
      if (again) giveUp(o, 'this book crashes the reader')
    }
    setNonce(freshNonce())
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
    giveUp(o, 'it did not open in time, twice')
    ready.current = false
    setNonce(freshNonce())
  }, [overdue])

  /** Retry after a deadline: a new page load; the open in flight (its file is still on disk) goes again on `ready`. */
  const retry = () => {
    ready.current = false
    setNonce(freshNonce())
  }

  const button = [styles.button, { backgroundColor: colors.primary }]
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.bar}>
        <Pressable onPress={pick} style={button}><Text style={styles.buttonText}>Pick book</Text></Pressable>
        <Pressable onPress={() => call('window.__fol.prev()')} style={button}><Text style={styles.buttonText}>‹</Text></Pressable>
        <Pressable onPress={() => call('window.__fol.next()')} style={button}><Text style={styles.buttonText}>›</Text></Pressable>
        <Pressable onPress={toggleFlow} disabled={!flow || !reflowable} style={[button, (!flow || !reflowable) && styles.disabled]}><Text style={styles.buttonText}>{flow === 'paginated' ? 'Scrolled' : 'Paginated'}</Text></Pressable>
        {userId && (
          <Pressable onPress={toggleFileSync} style={button}><Text style={styles.buttonText}>{fileSync ? 'Files: sync' : 'Files: local'}</Text></Pressable>
        )}
      </View>
      <Text style={[styles.heading, { color: colors.text }]} numberOfLines={1}>{heading}</Text>
      <ProgressLine setter={setProgress} color={colors.textSecondary} />
      {overdue && (
        <View style={styles.alert} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Text style={[styles.meta, { color: colors.error }]}>
            {overdue === 'opened'
              ? `${opening.current?.name ?? 'The book'} is taking too long to open.`
              : verdict === 'ok' ? 'The reader failed to load.' : t('updates.webView.readyFailed')}
          </Text>
          <Pressable onPress={retry} accessibilityRole="button" style={button}><Text style={styles.buttonText}>Retry</Text></Pressable>
        </View>
      )}
      {openError && <Text style={[styles.meta, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">{openError}</Text>}
      {error && <Text style={[styles.meta, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
      {offer && (
        <Pressable onPress={() => { goTo(offer, true); setOffer(null) }} style={styles.offer}>
          <Text style={[styles.meta, { color: colors.primary }]}>Read further on another device ({Math.round((offer.fraction ?? 0) * 100)}%): go there</Text>
        </Pressable>
      )}
      {books.length > 0 && (
        <ScrollView horizontal style={styles.books} contentContainerStyle={styles.booksRow}>
          {books.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => (b.local ? open({ file: bookFile(b.sha256), name: b.originalName }) : download(b))}
              style={[styles.book, { borderColor: colors.border }]}
            >
              <Text numberOfLines={1} style={[styles.meta, { color: colors.textSecondary }]}>{b.local ? b.title : `↓ ${b.title}`}</Text>
              {b.notSynced && (
                <>
                  <Text numberOfLines={2} style={[styles.meta, { color: colors.error }]}>Not synced: {b.notSynced}</Text>
                  <Pressable onPress={() => unpark(b)}>
                    <Text style={[styles.meta, { color: colors.primary }]}>Try again</Text>
                  </Pressable>
                </>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}
      <WebView
        key={nonce}
        ref={webView}
        style={styles.page}
        // README "WebView": no file access at all (the library's defaults, all off); the page reads its book by
        // XHR from the interceptor, so no book bytes cross the bridge. `*`: react-native-webview opens a
        // navigation outside originWhitelist in another app, so the filter is onShouldStartLoadWithRequest below.
        source={source}
        originWhitelist={['*']}
        onMessage={onMessage}
        // Runs as its own script on page start, so it answers even where the page fails to parse (#1228).
        injectedJavaScriptBeforeContentLoaded={USER_AGENT_PROBE}
        onRenderProcessGone={reload}
        onContentProcessDidTerminate={reload}
        // The page never navigates; only its own about:/blob:/data: loads pass.
        onShouldStartLoadWithRequest={({ url }) => /^(about|blob|data):/.test(url)}
      />
    </SafeAreaView>
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
  update: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  updateText: { alignItems: 'center', gap: 14 },
  updateTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  updateBody: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
})
