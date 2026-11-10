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
import { downloadV2Book, syncV2Library, type SyncHost } from '../../lib/v2reader/sync'
import { v2ReaderPageHtml } from '../../lib/v2reader/v2ReaderPage.generated'

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
    const file = await File.downloadFileAsync(url, v2File(staged), { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, idempotent: true })
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

/** Logs a failure; `show` also puts it on screen. */
const fail = (what: string, show?: (text: string) => void) => (e: unknown) => {
  console.log(`[v2] ${what} failed: ${e}`)
  show?.(`${what}: ${e}`)
}

/** Plan R2 is the Android route: iOS has no allowFileAccessFromFileURLs and refuses the file:// base. */
export default function V2ReaderScreen() {
  if (Platform.OS !== 'android') return <Text>Android dev route only (R2)</Text>
  return <V2Reader />
}

/** Re-renders alone on every `relocate`, not the WebView beside it. */
function ProgressLine({ setter, color }: { setter: MutableRefObject<(text: string) => void>; color: string }) {
  const [text, setText] = useState('')
  useEffect(() => { setter.current = setText }, [setter])
  return <Text style={[styles.meta, { color }]}>{text}</Text>
}

function V2Reader() {
  const { colors } = useTheme()
  const webView = useRef<WebView>(null)
  const [nonce, setNonce] = useState(freshNonce)
  const source = useMemo(() => ({ html: v2ReaderPageHtml(nonce), baseUrl: Paths.document.uri }), [nonce])
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  const setProgress = useRef<(text: string) => void>(() => {})
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [heading, setHeading] = useState('Pick a book')
  // null until the stored choice is read: the toggle is off until then, so no toggle can race the read.
  const [flow, setFlow] = useState<Flow | null>(null)
  useEffect(() => { storedFlow().then(setFlow) }, [])
  /** False for a fixed-layout book (CBZ): flow changes nothing there, so the toggle is off. */
  const [reflowable, setReflowable] = useState(true)
  /** The book open at the last renderer crash: one that crashes it twice is not reopened again. */
  const crashedFile = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  /** A programmatic move: the next relocate is the new baseline, not the reader moving. */
  const goTo = (p: PagePosition) => {
    reading.current.baseline = null
    call(`window.__fol.goTo(${JSON.stringify(p.cfi)})`)
  }

  // Opportunistic sync (R6): with a session (a guest's too), on open, after saves, never on the reading path.
  const sync = useRef(() => {})
  sync.current = () => {
    if (!userId) return
    syncV2Library(deviceLocalLibrary(), {
      userId,
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
  useEffect(() => {
    sync.current()
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
    setError(null)
    downloadV2Book(deviceLocalLibrary(), b.id, downloadIo).then(
      async (ok) => {
        if (!ok) return
        await refreshBooks()
        open({ file: bookFile(b.sha256), name: b.originalName })
      },
      fail('download', setError),
    )
  }

  const open = (target: Opening) => {
    // The page answers nothing for an open it has superseded, so a staged file left behind is dropped here.
    const previous = opening.current
    if (previous && isStaged(previous.file) && previous.file !== target.file) v2Storage().dropStaged(previous.file).catch(fail('drop'))
    opening.current = { ...target } // a new object even for the same file: an older onOpened sees it was superseded
    reading.current = { bookId: null, restored: false, baseline: null, cfi: null, index: null }
    setOffer(null)
    setError(null)
    setProgress.current('')
    if (ready.current) call(`window.__fol.openUrl(${JSON.stringify(v2File(target.file).uri)}, ${JSON.stringify(target.file)})`)
  }

  /** The open this answer belongs to, or null (logged) when a later open has replaced it. Explicit open id: #1069. */
  const answered = (name: unknown) => {
    if (opening.current?.file === name) return opening.current
    console.log(`[v2] stale answer for ${String(name)} dropped; current is ${opening.current?.file}`)
    return null
  }

  const pick = async () => {
    try {
      // Any file: the page tells the format by its bytes (EPUB, MOBI/AZW3, FB2, CBZ) and refuses the rest.
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
      if (result.canceled) return
      const asset = result.assets[0]
      const staged = `staging/${Date.now()}.epub`
      await new File(asset.uri).move(v2File(staged))
      open({ file: staged, name: asset.name })
    } catch (e) {
      fail('pick', setError)(e)
    }
  }

  const onOpened = async (current: Opening, m: { book: { sha256: string; size: number }; format?: string; title: string; author: string }) => {
    const s = v2Storage()
    // A reload or a new pick can replace this open during any await; then this answer stops there.
    const superseded = () => opening.current !== current
    const stored = await s.readStore(m.book.sha256)
    if (superseded()) return
    call(`window.__fol.restore(${JSON.stringify(stored)})`)
    setHeading([m.title || current.name, m.author].filter(Boolean).join(' — '))
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

  const onMessage = (event: WebViewMessageEvent) => {
    let m: any
    try { m = JSON.parse(event.nativeEvent.data) } catch { return }
    if (!m || typeof m !== 'object') return
    switch (m.type) {
      case 'ready':
        // The layout goes in first: injected calls run in order, so the open below uses it.
        storedFlow().then((f) => {
          call(`window.__fol.flow(${JSON.stringify(f)})`)
          ready.current = true
          if (opening.current) open(opening.current)
        })
        return
      case 'opened': {
        const current = answered(m.book?.name)
        if (!current) return
        setReflowable(m.reflowable !== false)
        onOpened(current, m).catch(fail('opened', setError))
        return
      }
      case 'open-failed': {
        const current = answered(m.name)
        if (!current) return
        if (isStaged(current.file)) v2Storage().dropStaged(current.file).catch(fail('drop'))
        opening.current = null
        setError(`cannot open ${current.name}: ${m.error}`)
        // The old book may still post a relocate until the page takes up this open (file read +
        // messages in flight); a failure must not leave it standing after open() cleared it (#1168).
        setProgress.current('')
        return
      }
      case 'restored':
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
        setProgress.current(`${Math.round((m.fraction ?? 0) * 100)}% · section ${(m.index ?? 0) + 1}/${m.sections ?? '?'}${m.toc ? ` · ${m.toc}` : ''}`)
        return
      case 'word':
        // Translation is not this slice: the tap reaches the host and stops here.
        console.log('[v2] word', m.word)
        return
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
      if (again) {
        opening.current = null
        if (isStaged(o.file)) v2Storage().dropStaged(o.file).catch(fail('drop'))
        setProgress.current('')
        setError(`cannot open ${o.name}: this book crashes the reader`)
      }
    }
    setNonce(freshNonce())
  }, [])

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
      {error && <Text style={[styles.meta, { color: colors.error }]}>{error}</Text>}
      {offer && (
        <Pressable onPress={() => { goTo(offer); setOffer(null) }} style={styles.offer}>
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
            </Pressable>
          ))}
        </ScrollView>
      )}
      <WebView
        key={nonce}
        ref={webView}
        style={styles.page}
        // README "WebView, dev route only": the file:// base lets the page read the retained file by
        // XHR, so no book bytes cross the bridge. Accepted for this route only until the R4 review.
        source={source}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs={false}
        onMessage={onMessage}
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
  heading: { paddingHorizontal: 8, fontSize: 15, fontWeight: '600' },
  meta: { paddingHorizontal: 8, fontSize: 12 },
  books: { flexGrow: 0, paddingVertical: 4 },
  booksRow: { gap: 6, paddingHorizontal: 8 },
  book: { borderWidth: 1, borderRadius: 6, paddingVertical: 4, maxWidth: 160 },
  page: { flex: 1 },
})
