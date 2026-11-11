import { useEffect, useRef, useState, type ChangeEvent } from 'react'
// ponytail: deep imports of apps/mobile source. The page and its library live there until the engine's home
// is settled (#1128, ADR-032); moving them on the mobile side breaks this file's tsc, visibly, not silently.
import { v2ReaderPageHtml } from '../../../../mobile/src/lib/v2reader/v2ReaderPage.generated'
import { addOpened, emptyLibrary, parseLibrary, type LibraryEntry } from '../../../../mobile/src/lib/v2reader/library.mjs'
import { nonceFromUuid } from '../../../../mobile/src/lib/v2reader/hostStorage'
import { createOpenTracker, type Take } from '../../../../mobile/src/lib/v2reader/openTracker.mjs'

/**
 * The V2 reader page (ADR-029) on the web, dev server only (R5, #1037): a second host for the page the
 * Android dev route hosts, driving the same contract (apps/mobile/src/lib/v2reader/README.md):
 * ready → openUrl → opened → restore → restored, then store / relocate / word / openLink.
 * The book comes from a file input; the library and the reader data live in localStorage only.
 * English-only on purpose: locale keys would land in the production bundle this page stays out of.
 */

const LIBRARY_KEY = 'v2reader:library'
const storeKey = (sha256: string) => `v2reader:store:${sha256}`
/** The reader's layout, a per-user setting (#1128): paginated unless the reader chose scrolled. */
const FLOW_KEY = 'v2reader:flow'
type Flow = 'paginated' | 'scrolled'

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

const readLibrary = () => parseLibrary(readItem(LIBRARY_KEY) ?? '') ?? emptyLibrary()

/** The mobile host's nonce, from the browser's CSPRNG: fresh per load, as v2ReaderPageHtml requires. */
const freshNonce = () => nonceFromUuid(crypto.randomUUID())

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
  if (e.source !== parent || !Array.isArray(e.data?.args)) return;
  const { call, args } = e.data;
  if (call !== 'openBytes') return Object.hasOwn(window.__fol, call) && window.__fol[call](...args);
  if (bookUrl) URL.revokeObjectURL(bookUrl);
  bookUrl = URL.createObjectURL(new Blob([args[0]]));
  window.__fol.openUrl(bookUrl, args[1]);
});`

/** Throws rather than load a page no message can reach: without the shim it would sit at "Pick an EPUB" forever. */
function withHostShim(html: string, nonce: string): string {
  const shimmed = html.replace('<body>', `<body><script nonce="${nonce}">${hostShim(location.origin)}</script>`)
  if (shimmed === html) throw new Error('V2 reader dev route: no <body> in the generated page to put the host shim in')
  return shimmed
}

/**
 * The open in flight: `name` is unique per pick and echoed in `opened`/`open-failed`, so a superseded
 * answer is dropped. `bytes` until the page has been handed them (it may not be `ready` yet).
 */
type Opening = { name: string; originalName: string; bytes?: ArrayBuffer }

export default function V2ReaderDevPage() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [srcDoc] = useState(() => {
    const nonce = freshNonce()
    return withHostShim(v2ReaderPageHtml(nonce), nonce)
  })
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  /** Which page answer belongs to which open (openTracker.mjs): a book kept on screen, a stale `restored`. */
  const [tracker] = useState(() => createOpenTracker<Opening>())
  const picks = useRef(0)
  const [books, setBooks] = useState<LibraryEntry[]>(() => readLibrary().books)
  const [heading, setHeading] = useState('Pick a book')
  const [flow, setFlow] = useState<Flow>(() => (readItem(FLOW_KEY) === 'scrolled' ? 'scrolled' : 'paginated'))
  const flowRef = useRef(flow)
  /** `opened.annotatable`: false on a CBZ (images only) and a PDF (no highlights yet): no highlight button (the page refuses it too). */
  const [annotatable, setAnnotatable] = useState(true)
  /** False for a fixed-layout book (CBZ): flow changes nothing there. */
  const [reflowable, setReflowable] = useState(true)
  const [status, setStatus] = useState('')
  const [restored, setRestored] = useState('')
  const [error, setError] = useState<string | null>(null)

  const call = (name: string, args: unknown[] = [], transfer: Transferable[] = []) =>
    frame.current?.contentWindow?.postMessage({ call: name, args }, location.origin, transfer)
  const flushOpen = () => {
    const o = opening.current
    if (!ready.current || !o?.bytes) return
    call('openBytes', [o.bytes, o.name], [o.bytes])
    o.bytes = undefined
  }

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again
    if (!file) return
    // Nothing of the previous book may stay on screen beside this one's answer (or its error).
    setError(null)
    setHeading(`Opening ${file.name}`)
    setStatus('')
    setRestored('')
    opening.current = { name: `${++picks.current}/${file.name}`, originalName: file.name, bytes: await file.arrayBuffer() }
    tracker.open(opening.current.name, opening.current)
    flushOpen()
  }

  useEffect(() => {
    /** The page's book is `t.open`'s (openTracker.mjs: the open in flight, or a book the page kept on screen). */
    const takeOpened = ({ open: current, opened: m }: Take<Opening, any>) => {
      opening.current = current
      call('restore', [readItem(storeKey(m.book.sha256))])
      setAnnotatable(m.annotatable !== false)
      setReflowable(m.reflowable !== false)
      setHeading([m.title || current.originalName, m.author].filter(Boolean).join(' — '))
      const { lib } = addOpened(readLibrary(), { ...m.book, title: m.title, author: m.author, originalName: current.originalName })
      writeItem(LIBRARY_KEY, JSON.stringify(lib))
      setBooks(lib.books)
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data !== 'string') return
      let m: any
      try { m = JSON.parse(e.data) } catch { return }
      switch (m?.type) {
        case 'ready':
          // The stored layout before the first open: messages arrive in order, and a setting is not a switch.
          call('flow', [flowRef.current])
          ready.current = true
          flushOpen()
          return
        case 'opened': {
          const t = tracker.opened(m)
          if (t) takeOpened(t)
          return
        }
        case 'open-failed': {
          const f = tracker.failed(m.name)
          if (!f) return
          setError(`cannot open ${f.failed.originalName}: ${m.error}`)
          // The old book may still post a relocate until the page takes up this open (file read +
          // messages in flight); a failure must not leave it standing after pick() cleared it (#1168).
          setStatus('')
          opening.current = null
          // The page kept a book on screen that answered meanwhile: it is the one read now.
          if (f.take) takeOpened(f.take)
          return
        }
        case 'restored':
          // Only for the book taken last: a stale answer must not show another book as restored.
          if (!tracker.restored(m)) return
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
          // No CFI (a book that is not `annotatable`, e.g. a PDF): no label can be drawn, none is asked for.
          if (m.cfi) call('showTranslation', [m.cfi, m.index, `dev: ${m.word}`])
          return
        case 'openLink':
          if (/^https?:\/\//i.test(m.href)) window.open(m.href, '_blank', 'noopener,noreferrer')
          return
        case 'telemetry':
          // Dev route: logged only; the event is defined by the page (README, telemetry).
          console.log('[v2] telemetry', JSON.stringify(m))
          return
        case 'log':
          console.log(`[v2 page] ${m.level}: ${m.msg}`)
      }
    }
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  }, [])

  const toggleFlow = () => {
    const next: Flow = flow === 'paginated' ? 'scrolled' : 'paginated'
    setFlow(next)
    flowRef.current = next
    writeItem(FLOW_KEY, next)
    if (ready.current) call('flow', [next])
  }

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: 8, boxSizing: 'border-box', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="file" accept=".epub,.mobi,.azw3,.azw,.fb2,.fbz,.cbz,.pdf,application/epub+zip,application/pdf" onChange={pick} aria-label="Pick EPUB" />
        <button onClick={() => call('prev')}>‹ Prev</button>
        <button onClick={() => call('next')}>Next ›</button>
        {annotatable && <button onClick={() => call('highlightSelection')}>Highlight</button>}
        <button onClick={toggleFlow} disabled={!reflowable}>{flow === 'paginated' ? 'Scrolled' : 'Paginated'}</button>
      </div>
      <strong data-testid="v2-heading">{heading}</strong>
      <span data-testid="v2-status">{status}</span>
      <span data-testid="v2-restore">{restored}</span>
      {error && <span role="alert">{error}</span>}
      <ul data-testid="v2-library" style={{ margin: 0 }}>
        {books.map((b) => <li key={b.id}>{b.title}</li>)}
      </ul>
      {/* allow-same-origin is required: foliate reads its section frames' documents, and under an opaque
          origin every nested frame gets its own. So the page shares this dev origin, and the page CSP is the
          only script barrier (README "Sandbox"). A book script past it would reach this origin's localStorage
          AND its /api session cookie: more than Android's file:// exposes. Bounded only by main.tsx keeping
          the route on the dev server. */}
      <iframe ref={frame} title="V2 reader" sandbox="allow-scripts allow-same-origin" srcDoc={srcDoc} style={{ flex: 1, border: '1px solid #ccc' }} />
    </main>
  )
}
