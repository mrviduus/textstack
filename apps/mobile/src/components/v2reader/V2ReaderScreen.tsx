import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import { uuid } from 'expo-modules-core'
import { createV2Storage, nonceFromUuid, type LibraryBook, type V2Files, type V2Storage } from '../../lib/v2reader/hostStorage'
import { v2ReaderPageHtml } from '../../lib/v2reader/v2ReaderPage.generated'
import { colors } from '../../theme/colors'

/**
 * The V2 reader (ADR-029) on Android, dev builds only: reached through `app/dev/epub-v2.tsx`.
 * Hosts the generated page and drives the contract in src/lib/v2reader/README.md:
 * ready → openUrl → opened → restore → restored, then store / relocate / word / openLink.
 */

/** `name` under <documents>/v2/, e.g. `books/<sha256>.epub`. */
const v2File = (name: string) => new File(new Directory(Paths.document, 'v2'), ...name.split('/'))

function deviceFiles(): V2Files {
  const root = new Directory(Paths.document, 'v2')
  // Anything still staged belongs to an open that never finished in an earlier process.
  const staging = new Directory(root, 'staging')
  if (staging.exists) staging.delete()
  for (const dir of ['books', 'store', 'staging']) new Directory(root, dir).create({ intermediates: true, idempotent: true })
  return {
    read: async (name) => (v2File(name).exists ? v2File(name).text() : null),
    write: async (name, text) => v2File(name).write(text),
    move: (from, to) => v2File(from).move(v2File(to), { overwrite: true }),
    exists: (name) => v2File(name).exists,
    remove: (name) => { if (v2File(name).exists) v2File(name).delete() },
  }
}

// One storage for the process, so every write goes through its one chain.
let storage: V2Storage | null = null
const v2Storage = () => (storage ??= createV2Storage(deviceFiles()))

/** Expo's uuid v4 is the platform CSPRNG (java.util.UUID.randomUUID → SecureRandom). */
const freshNonce = () => nonceFromUuid(uuid.v4())

/**
 * The file the page is opening: retained (`books/…`) or staged (`staging/…`, then `staged` is set).
 * `token` is the name handed to `openUrl`; the page echoes it in `opened`/`open-failed`, so an answer
 * to an earlier open is recognised as stale instead of being paired with this one's file.
 */
type Opening = { token: string; file: string; name: string; staged: string | null }

let openSeq = 0
const report = (what: string) => (e: unknown) => console.log(`[v2] ${what} failed: ${e}`)

export default function V2ReaderScreen() {
  const webView = useRef<WebView>(null)
  const [nonce, setNonce] = useState(freshNonce)
  const pageHtml = useMemo(() => v2ReaderPageHtml(nonce), [nonce])
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [heading, setHeading] = useState('Pick an EPUB')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)

  const call = (js: string) => webView.current?.injectJavaScript(`${js};true`)
  const fail = (what: string) => (e: unknown) => { report(what)(e); setError(`${what}: ${e}`) }
  const refreshBooks = useCallback(() => {
    v2Storage().books().then(setBooks, fail('library'))
  }, [])
  useEffect(refreshBooks, [refreshBooks])

  const open = (target: Omit<Opening, 'token'>) => {
    const current = { ...target, token: `${++openSeq}:${target.name}` }
    opening.current = current
    setError(null)
    setProgress('')
    if (ready.current) call(`window.__fol.openUrl(${JSON.stringify(v2File(current.file).uri)}, ${JSON.stringify(current.token)})`)
  }

  /** The open this answer belongs to, or null (logged) when a later open has replaced it. */
  const answered = (token: unknown) => {
    if (opening.current?.token === token) return opening.current
    console.log(`[v2] stale answer for ${String(token)} dropped; current is ${opening.current?.token}`)
    return null
  }

  const pick = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/epub+zip', 'application/octet-stream'], copyToCacheDirectory: true })
      if (result.canceled) return
      const asset = result.assets[0]
      v2Storage() // creates the directories before the first move into them
      const staged = `staging/${Date.now()}.epub`
      await new File(asset.uri).move(v2File(staged))
      open({ file: staged, name: asset.name, staged })
    } catch (e) {
      fail('pick')(e)
    }
  }

  const onOpened = async (current: Opening, m: { book: { sha256: string; size: number }; title: string; author: string }) => {
    const s = v2Storage()
    call(`window.__fol.restore(${JSON.stringify(await s.readStore(m.book.sha256))})`)
    setHeading([m.title || current.name, m.author].filter(Boolean).join(' — '))
    await s.addOpened({ ...m.book, title: m.title, author: m.author, originalName: current.name }, current.staged)
    // From here on this book is the retained copy: a reloaded page reopens that, not the moved staging file.
    const retained = await s.bookName(m.book.sha256)
    if (opening.current === current) opening.current = { ...current, file: retained, staged: null }
    refreshBooks()
  }

  const onMessage = (event: WebViewMessageEvent) => {
    let m: any
    try { m = JSON.parse(event.nativeEvent.data) } catch { return }
    switch (m.type) {
      case 'ready':
        ready.current = true
        if (opening.current) open(opening.current)
        return
      case 'opened': {
        const current = answered(m.book?.name)
        if (current) onOpened(current, m).catch(fail('opened'))
        return
      }
      case 'open-failed': {
        const current = answered(m.name)
        if (!current) return
        if (current.staged) v2Storage().dropStaged(current.staged)
        opening.current = null
        setError(`cannot open ${current.name}: ${m.error}`)
        return
      }
      case 'restored':
        console.log('[v2] restored', JSON.stringify(m))
        setProgress(`restore: ${m.position}`)
        return
      case 'store':
        v2Storage().writeStore(m.key, m.json).catch(fail('store'))
        return
      case 'relocate':
        setProgress(`${Math.round((m.fraction ?? 0) * 100)}% · section ${(m.index ?? 0) + 1}/${m.sections ?? '?'}${m.toc ? ` · ${m.toc}` : ''}`)
        return
      case 'word':
        // Translation is not this slice: the tap reaches the host and stops here.
        console.log('[v2] word', m.word)
        return
      case 'openLink':
        if (/^https?:\/\//i.test(m.href)) Linking.openURL(m.href).catch(report('openLink'))
        return
      case 'log':
        console.log(`[v2 page] ${m.level}: ${m.msg}`)
    }
  }

  const openRetained = (b: LibraryBook) =>
    v2Storage().bookName(b.sha256).then((file) => open({ file, name: b.originalName, staged: null }), fail('open'))

  // A page that is gone is a new load: a new nonce, and the open starts again from `ready`.
  const reload = () => { ready.current = false; setNonce(freshNonce()) }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.bar}>
        <Pressable onPress={pick} style={styles.button}><Text style={styles.buttonText}>Pick EPUB</Text></Pressable>
        <Pressable onPress={() => call('window.__fol.prev()')} style={styles.button}><Text style={styles.buttonText}>‹</Text></Pressable>
        <Pressable onPress={() => call('window.__fol.next()')} style={styles.button}><Text style={styles.buttonText}>›</Text></Pressable>
      </View>
      <Text style={styles.heading} numberOfLines={1}>{heading}</Text>
      <Text style={styles.meta}>{progress}</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      {books.length > 0 && (
        <ScrollView horizontal style={styles.books} contentContainerStyle={styles.booksRow}>
          {books.map((b) => (
            <Pressable key={b.id} onPress={() => openRetained(b)} style={styles.book}>
              <Text numberOfLines={1} style={styles.meta}>{b.title}</Text>
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
        source={{ html: pageHtml, baseUrl: Paths.document.uri }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs={false}
        onMessage={onMessage}
        onRenderProcessGone={reload}
        onContentProcessDidTerminate={reload}
        // The page never navigates. No file: — a top frame on file:///data/… would get the bridge;
        // the page's own load (loadDataWithBaseURL) does not pass through here on Android.
        onShouldStartLoadWithRequest={({ url }) => /^(about|blob|data):/.test(url)}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bar: { flexDirection: 'row', gap: 8, padding: 8 },
  button: { backgroundColor: colors.primary, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6 },
  buttonText: { color: '#fff', fontWeight: '600' },
  heading: { paddingHorizontal: 8, fontSize: 15, fontWeight: '600', color: colors.text },
  meta: { paddingHorizontal: 8, fontSize: 12, color: colors.textSecondary },
  error: { paddingHorizontal: 8, fontSize: 12, color: colors.error },
  books: { flexGrow: 0, paddingVertical: 4 },
  booksRow: { gap: 6, paddingHorizontal: 8 },
  book: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingVertical: 4, maxWidth: 160 },
  page: { flex: 1 },
})
