import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { v2ReaderPageHtml } from '../../../../mobile/src/lib/v2reader/v2ReaderPage.generated'
import { addOpened, emptyLibrary, parseLibrary } from '../../../../mobile/src/lib/v2reader/library.mjs'

/**
 * The V2 reader page (ADR-029) on the web, dev server only (R5, #1037): a second host for the page the
 * Android dev route hosts, driving the same contract (apps/mobile/src/lib/v2reader/README.md):
 * ready → openUrl → opened → restore → restored, then store / relocate / word / openLink.
 * The book comes from a file input; the library and the reader data live in localStorage only.
 * English-only on purpose: locale keys would land in the production bundle this page stays out of.
 */

const LIBRARY_KEY = 'v2reader:library'
const storeKey = (sha256: string) => `v2reader:store:${sha256}`

// A full, disabled or cleared localStorage costs the dev data, never the open book.
function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.warn(`[v2] localStorage write ${key} failed: ${e}`)
  }
}

type LibraryBook = { id: string; title: string; author: string; originalName: string }
const readLibrary = () => parseLibrary(readItem(LIBRARY_KEY) ?? '') ?? emptyLibrary()

/** 18 random bytes as hex: v2ReaderPageHtml wants base64/hex of 16+ chars, fresh per load. */
const freshNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Stands in for react-native-webview inside the iframe, under the page's own nonce so its CSP admits it.
 * Out: the page's `ReactNativeWebView.postMessage(json)` goes to this window. In: `{ call, args }` from
 * this window becomes `window.__fol[call](...args)`; `openBytes` hands the page a blob: URL of the
 * transferred bytes for `openUrl`, which the CSP's `connect-src blob:` lets it read.
 */
const hostShim = (parentOrigin: string) => `
window.ReactNativeWebView = { postMessage: (json) => parent.postMessage(json, ${JSON.stringify(parentOrigin)}) };
let bookUrl = null;
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const { call, args } = e.data;
  if (call !== 'openBytes') return window.__fol[call](...args);
  if (bookUrl) URL.revokeObjectURL(bookUrl);
  bookUrl = URL.createObjectURL(new Blob([args[0]]));
  window.__fol.openUrl(bookUrl, args[1]);
});`

const withHostShim = (html: string, nonce: string) =>
  html.replace('<body>', `<body><script nonce="${nonce}">${hostShim(location.origin)}</script>`)

/** The open in flight: `name` is unique per pick and echoed in `opened`/`open-failed`, so a superseded answer is dropped. */
type Opening = { name: string; originalName: string }

export default function V2ReaderDevPage() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [nonce] = useState(freshNonce)
  const srcDoc = useMemo(() => withHostShim(v2ReaderPageHtml(nonce), nonce), [nonce])
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  /** Picked bytes the page has not been handed yet (it may not be `ready`). */
  const pending = useRef<ArrayBuffer | null>(null)
  const picks = useRef(0)
  const [books, setBooks] = useState<LibraryBook[]>(() => readLibrary().books)
  const [heading, setHeading] = useState('Pick an EPUB')
  const [status, setStatus] = useState('')
  const [restored, setRestored] = useState('')
  const [error, setError] = useState<string | null>(null)

  const call = (name: string, ...args: unknown[]) => frame.current?.contentWindow?.postMessage({ call: name, args }, location.origin)
  const flushOpen = () => {
    const bytes = pending.current
    if (!ready.current || !bytes || !opening.current) return
    pending.current = null
    frame.current?.contentWindow?.postMessage({ call: 'openBytes', args: [bytes, opening.current.name] }, location.origin, [bytes])
  }

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again
    if (!file) return
    setError(null)
    const bytes = await file.arrayBuffer()
    opening.current = { name: `${++picks.current}/${file.name}`, originalName: file.name }
    pending.current = bytes
    flushOpen()
  }

  useEffect(() => {
    /** The open this answer belongs to, or null when a later pick has replaced it. */
    const answered = (name: unknown) => (opening.current && opening.current.name === name ? opening.current : null)
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data !== 'string') return
      let m: any
      try { m = JSON.parse(e.data) } catch { return }
      switch (m?.type) {
        case 'ready':
          ready.current = true
          flushOpen()
          return
        case 'opened': {
          const current = answered(m.book?.name)
          if (!current) return
          call('restore', readItem(storeKey(m.book.sha256)))
          setHeading([m.title || current.originalName, m.author].filter(Boolean).join(' — '))
          const { lib } = addOpened(readLibrary(), { ...m.book, title: m.title, author: m.author, originalName: current.originalName })
          writeItem(LIBRARY_KEY, JSON.stringify(lib))
          setBooks(lib.books)
          return
        }
        case 'open-failed': {
          const current = answered(m.name)
          if (!current) return
          setError(`cannot open ${current.originalName}: ${m.error}`)
          opening.current = null
          return
        }
        case 'restored':
          setRestored(`restore: ${m.position}`)
          return
        case 'store':
          writeItem(storeKey(m.key), m.json)
          return
        case 'relocate':
          setStatus(`${Math.round((m.fraction ?? 0) * 100)}% · section ${(m.index ?? 0) + 1}/${m.sections ?? '?'}${m.toc ? ` · ${m.toc}` : ''}`)
          return
        case 'word':
          // Dev stub: no translation service here; the label proves the word → showTranslation round trip.
          call('showTranslation', m.cfi, m.index, `dev: ${m.word}`)
          return
        case 'openLink':
          if (/^https?:\/\//i.test(m.href)) window.open(m.href, '_blank', 'noopener,noreferrer')
          return
        case 'log':
          console.log(`[v2 page] ${m.level}: ${m.msg}`)
      }
    }
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  }, [])

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: 8, boxSizing: 'border-box', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="file" accept=".epub,application/epub+zip" onChange={pick} aria-label="Pick EPUB" />
        <button onClick={() => call('prev')}>‹ Prev</button>
        <button onClick={() => call('next')}>Next ›</button>
        <button onClick={() => call('highlightSelection')}>Highlight</button>
      </div>
      <strong data-testid="v2-heading">{heading}</strong>
      <span data-testid="v2-status">{status}</span>
      <span data-testid="v2-restore">{restored}</span>
      {error && <span role="alert">{error}</span>}
      <ul data-testid="v2-library" style={{ margin: 0 }}>
        {books.map((b) => <li key={b.id}>{b.title}</li>)}
      </ul>
      {/* allow-same-origin is required: foliate reads its section frames' documents, and under an opaque
          origin every nested frame gets its own. So the page shares this dev origin, as it shares file://
          on Android; the page CSP stays the only script barrier (README "Sandbox"). */}
      <iframe ref={frame} key={nonce} title="V2 reader" sandbox="allow-scripts allow-same-origin" srcDoc={srcDoc} style={{ flex: 1, border: '1px solid #ccc' }} />
    </main>
  )
}
