import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import { uuid } from 'expo-modules-core'
import { useTheme } from '../../context/ThemeContext'
import { bookFile, createV2Storage, nonceFromUuid, type LibraryBook, type V2Files, type V2Storage } from '../../lib/v2reader/hostStorage'
import { v2ReaderPageHtml } from '../../lib/v2reader/v2ReaderPage.generated'

/**
 * The V2 reader (ADR-029) on Android, dev builds only: reached through `app/dev/epub-v2.tsx`.
 * Hosts the generated page and drives the contract in src/lib/v2reader/README.md:
 * ready → openUrl → opened → restore → restored, then store / relocate / word / openLink.
 */

const V2_ROOT = new Directory(Paths.document, 'v2')

/** `name` under <documents>/v2/, e.g. `books/<sha256>.epub`. */
const v2File = (name: string) => new File(V2_ROOT, ...name.split('/'))

function deviceFiles(): V2Files {
  // Anything still staged belongs to an open that never finished in an earlier process.
  const staging = new Directory(V2_ROOT, 'staging')
  if (staging.exists) staging.delete()
  for (const dir of ['books', 'store', 'staging']) new Directory(V2_ROOT, dir).create({ intermediates: true, idempotent: true })
  return {
    read: async (name) => {
      const file = v2File(name)
      return file.exists ? file.text() : null
    },
    write: async (name, text) => v2File(name).write(text),
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
const v2Storage = () => (storage ??= createV2Storage(deviceFiles()))

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
  const [heading, setHeading] = useState('Pick an EPUB')
  const [error, setError] = useState<string | null>(null)

  const call = (js: string) => webView.current?.injectJavaScript(`${js};true`)
  useEffect(() => {
    v2Storage().books().then(setBooks, fail('library', setError))
  }, [])

  const open = (target: Opening) => {
    // The page answers nothing for an open it has superseded, so a staged file left behind is dropped here.
    const previous = opening.current
    if (previous && isStaged(previous.file) && previous.file !== target.file) v2Storage().dropStaged(previous.file).catch(fail('drop'))
    opening.current = { ...target } // a new object even for the same file: an older onOpened sees it was superseded
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
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/epub+zip', 'application/octet-stream'], copyToCacheDirectory: true })
      if (result.canceled) return
      const asset = result.assets[0]
      const staged = `staging/${Date.now()}.epub`
      await new File(asset.uri).move(v2File(staged))
      open({ file: staged, name: asset.name })
    } catch (e) {
      fail('pick', setError)(e)
    }
  }

  const onOpened = async (current: Opening, m: { book: { sha256: string; size: number }; title: string; author: string }) => {
    const s = v2Storage()
    // A reload or a new pick can replace this open during any await; then this answer stops there.
    const superseded = () => opening.current !== current
    const stored = await s.readStore(m.book.sha256)
    if (superseded()) return
    call(`window.__fol.restore(${JSON.stringify(stored)})`)
    setHeading([m.title || current.name, m.author].filter(Boolean).join(' — '))
    let added
    try {
      added = await s.addOpened(
        { ...m.book, title: m.title, author: m.author, originalName: current.name },
        isStaged(current.file) ? current.file : null,
      )
    } catch (e) {
      // The staged path is gone once addOpened moved or dropped it: a reload must not reopen it. The error stays on screen (the caller shows it).
      if (!superseded()) opening.current = null
      throw e
    }
    const { retained, books } = added
    setBooks(books)
    // From here on this book is the retained copy: a reloaded page reopens that, not the moved staging file.
    if (!superseded()) opening.current = { ...current, file: retained }
  }

  const onMessage = (event: WebViewMessageEvent) => {
    let m: any
    try { m = JSON.parse(event.nativeEvent.data) } catch { return }
    if (!m || typeof m !== 'object') return
    switch (m.type) {
      case 'ready':
        ready.current = true
        if (opening.current) open(opening.current)
        return
      case 'opened': {
        const current = answered(m.book?.name)
        if (current) onOpened(current, m).catch(fail('opened', setError))
        return
      }
      case 'open-failed': {
        const current = answered(m.name)
        if (!current) return
        if (isStaged(current.file)) v2Storage().dropStaged(current.file).catch(fail('drop'))
        opening.current = null
        setError(`cannot open ${current.name}: ${m.error}`)
        return
      }
      case 'restored':
        console.log('[v2] restored', JSON.stringify(m))
        setProgress.current(`restore: ${m.position}`)
        return
      case 'store':
        v2Storage().writeStore(m.key, m.json).catch(fail('store', setError))
        return
      case 'relocate':
        setProgress.current(`${Math.round((m.fraction ?? 0) * 100)}% · section ${(m.index ?? 0) + 1}/${m.sections ?? '?'}${m.toc ? ` · ${m.toc}` : ''}`)
        return
      case 'word':
        // Translation is not this slice: the tap reaches the host and stops here.
        console.log('[v2] word', m.word)
        return
      case 'openLink':
        if (/^https?:\/\//i.test(m.href)) Linking.openURL(m.href).catch(fail('openLink'))
        return
      case 'log':
        console.log(`[v2 page] ${m.level}: ${m.msg}`)
    }
  }

  // A page that is gone is a new load: a new nonce, and the open starts again from `ready`.
  const reload = useCallback(() => { ready.current = false; setNonce(freshNonce()) }, [])

  const button = [styles.button, { backgroundColor: colors.primary }]
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.bar}>
        <Pressable onPress={pick} style={button}><Text style={styles.buttonText}>Pick EPUB</Text></Pressable>
        <Pressable onPress={() => call('window.__fol.prev()')} style={button}><Text style={styles.buttonText}>‹</Text></Pressable>
        <Pressable onPress={() => call('window.__fol.next()')} style={button}><Text style={styles.buttonText}>›</Text></Pressable>
      </View>
      <Text style={[styles.heading, { color: colors.text }]} numberOfLines={1}>{heading}</Text>
      <ProgressLine setter={setProgress} color={colors.textSecondary} />
      {error && <Text style={[styles.meta, { color: colors.error }]}>{error}</Text>}
      {books.length > 0 && (
        <ScrollView horizontal style={styles.books} contentContainerStyle={styles.booksRow}>
          {books.map((b) => (
            <Pressable key={b.id} onPress={() => open({ file: bookFile(b.sha256), name: b.originalName })} style={[styles.book, { borderColor: colors.border }]}>
              <Text numberOfLines={1} style={[styles.meta, { color: colors.textSecondary }]}>{b.title}</Text>
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
  heading: { paddingHorizontal: 8, fontSize: 15, fontWeight: '600' },
  meta: { paddingHorizontal: 8, fontSize: 12 },
  books: { flexGrow: 0, paddingVertical: 4 },
  booksRow: { gap: 6, paddingHorizontal: 8 },
  book: { borderWidth: 1, borderRadius: 6, paddingVertical: 4, maxWidth: 160 },
  page: { flex: 1 },
})
