import { useEffect, useRef, useState, type ReactNode } from 'react'
// ponytail: deep imports of apps/mobile source. The page and its helpers live there until the engine's home
// is settled (#1128, ADR-032); moving them on the mobile side breaks this file's tsc, visibly, not silently.
import { createOpenTracker, type Take } from '../../../../mobile/src/lib/v2reader/openTracker.mjs'
import { V2_READER_FRAME_PATH } from '../../../../mobile/src/lib/v2reader/framePath.mjs'
import { useTranslation } from '../../hooks/useTranslation'

/**
 * The V2 reader page (ADR-029) on the web: one host for the dev route (/dev/reader-v2, a picked file) and the
 * production route (/:lang/library/my/:id/read-v2, the V2 file's bytes), #1225. It drives the contract the
 * Android host drives (apps/mobile/src/lib/v2reader/README.md): ready → openBytes → opened → restore → restored,
 * then store / relocate / word / openLink. Reader data (position, highlights) and the layout live in
 * localStorage until the V2 sync client takes them (#1226).
 */

/** A book to open: a new object opens it (the same object again does nothing). `bytes` are transferred. */
export interface V2HostBook { bytes: ArrayBuffer; name: string }
/** The page's `opened` message, as far as hosts read it. */
export interface V2OpenedMessage {
  title?: string
  author?: string
  annotatable?: boolean
  reflowable?: boolean
  book: { sha256: string; size: number; name?: string }
}

const storeKey = (sha256: string) => `v2reader:store:${sha256}`
/** The reader's layout, a per-user setting (#1128): paginated unless the reader chose scrolled. */
const FLOW_KEY = 'v2reader:flow'
type Flow = 'paginated' | 'scrolled'

// A full, disabled or cleared localStorage costs the reader data, never the open book.
export function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
export function writeItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.warn(`[v2] localStorage write ${key} failed: ${e}`)
  }
}

/**
 * The page as its own same-origin document (#1219): a no-store shell with a fresh nonce per response and the
 * page code as a cached script (frame.mjs; the dev/preview servers through vite.config.ts, nginx in
 * production). Not srcdoc: that inherits this document's CSP, which refuses the page's scripts.
 */
const FRAME_SRC = V2_READER_FRAME_PATH
/**
 * No `ready` by then: the frame is not the page (a wrong path, an error, the SPA's own index.html nested in
 * it, a refused script). Said on screen, since nothing else ever would (#1080 item 3, web host). The default
 * suits a local server; a route over the network passes its own. Real deadlines: slice 4 (#1227).
 */
export const READY_DEADLINE_MS = 10_000

/**
 * The open in flight: `name` is unique per open and echoed in `opened`/`open-failed`, so a superseded
 * answer is dropped. `bytes` until the page has been handed them (it may not be `ready` yet).
 */
type Opening = { name: string; originalName: string; bytes?: ArrayBuffer }

interface Props {
  book: V2HostBook | null
  /** The page took a book (after the open tracker's checks): the dev route records it in its library. */
  onOpened?: (m: V2OpenedMessage, originalName: string) => void
  /** Controls before the reader's own (the dev route's file input). */
  toolbar?: ReactNode
  /** Between the status lines and the frame (the dev route's library; the production route's load error). */
  children?: ReactNode
  /** The heading until the first open (the prod route clears it on a load error). */
  idleHeading?: string
  /** How long the frame may take to send `ready`. */
  readyDeadlineMs?: number
  /** The dev route's debug aids: the `restore:` line and a stub translation label on a tapped word. */
  dev?: boolean
}

export function V2ReaderHost({ book, onOpened, toolbar, children, idleHeading = '', readyDeadlineMs = READY_DEADLINE_MS, dev = false }: Props) {
  const { t } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const opening = useRef<Opening | null>(null)
  /** Which page answer belongs to which open (openTracker.mjs): a book kept on screen, a stale `restored`. */
  const [tracker] = useState(() => createOpenTracker<Opening, V2OpenedMessage>())
  const opens = useRef(0)
  const lastBook = useRef<V2HostBook | null>(null)
  const onOpenedRef = useRef(onOpened)
  onOpenedRef.current = onOpened
  const [heading, setHeading] = useState('')
  const [flow, setFlow] = useState<Flow>(() => (readItem(FLOW_KEY) === 'scrolled' ? 'scrolled' : 'paginated'))
  const flowRef = useRef(flow)
  /** `opened.annotatable`: false on a CBZ (images only) and a PDF (no highlights yet): no highlight button (the page refuses it too). */
  const [annotatable, setAnnotatable] = useState(true)
  /** False for a fixed-layout book (CBZ): flow changes nothing there. */
  const [reflowable, setReflowable] = useState(true)
  const [status, setStatus] = useState('')
  const [restored, setRestored] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [frameFailed, setFrameFailed] = useState(false)

  const call = (name: string, args: unknown[] = [], transfer: Transferable[] = []) =>
    frame.current?.contentWindow?.postMessage({ call: name, args }, location.origin, transfer)
  const flushOpen = () => {
    const o = opening.current
    if (!ready.current || !o?.bytes) return
    call('openBytes', [o.bytes, o.name], [o.bytes])
    o.bytes = undefined
  }

  useEffect(() => {
    // The same object again (a re-render, StrictMode's second run) is not a new open: its bytes may be gone.
    if (!book || book === lastBook.current) return
    lastBook.current = book
    // Nothing of the previous book may stay on screen beside this one's answer (or its error).
    setError(null)
    setHeading(t('v2Reader.opening', { name: book.name }))
    setStatus('')
    setRestored('')
    opening.current = { name: `${++opens.current}/${book.name}`, originalName: book.name, bytes: book.bytes }
    tracker.open(opening.current.name, opening.current)
    flushOpen()
  }, [book])

  useEffect(() => {
    const timer = setTimeout(() => { if (!ready.current) setFrameFailed(true) }, readyDeadlineMs)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    /** The page's book is `take.open`'s (openTracker.mjs: the open in flight, or a book the page kept on screen). */
    const takeOpened = ({ open: current, opened: m }: Take<Opening, V2OpenedMessage>) => {
      opening.current = current
      call('restore', [readItem(storeKey(m.book.sha256))])
      setAnnotatable(m.annotatable !== false)
      setReflowable(m.reflowable !== false)
      setHeading([m.title || current.originalName, m.author].filter(Boolean).join(' — '))
      onOpenedRef.current?.(m, current.originalName)
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== location.origin || typeof e.data !== 'string') return
      let m: any
      try { m = JSON.parse(e.data) } catch { return }
      switch (m?.type) {
        case 'ready':
          setFrameFailed(false)
          // The stored layout before the first open: messages arrive in order, and a setting is not a switch.
          call('flow', [flowRef.current])
          ready.current = true
          flushOpen()
          return
        case 'opened': {
          const take = tracker.opened(m)
          if (take) takeOpened(take)
          return
        }
        case 'open-failed': {
          const f = tracker.failed(m.name)
          if (!f) return
          setError(t('v2Reader.cannotOpen', { name: f.failed.originalName, error: String(m.error) }))
          // The old book may still post a relocate until the page takes up this open (bytes read +
          // messages in flight); a failure must not leave it standing after the open cleared it (#1168).
          setStatus('')
          opening.current = null
          // The page kept a book on screen that answered meanwhile: it is the one read now.
          if (f.take) takeOpened(f.take)
          return
        }
        case 'restored':
          // Only for the book taken last: a stale answer must not show another book as restored.
          if (!tracker.restored(m)) return
          setRestored(t('v2Reader.restore', { state: String(m.position) }))
          return
        case 'store':
          writeItem(storeKey(m.key), m.json)
          return
        case 'relocate':
          // Not after a failed open, until the next open (openTracker.mjs showsPosition: the rule and its cost).
          if (!tracker.showsPosition()) return
          setStatus(t('v2Reader.position', { percent: Math.round((m.fraction ?? 0) * 100), index: (m.index ?? 0) + 1, sections: m.sections ?? '?' })
            + (m.toc ? ` · ${m.toc}` : ''))
          return
        case 'word':
          // Dev stub: no translation service yet; the label proves the word → showTranslation round trip.
          // No CFI (a book that is not `annotatable`, e.g. a PDF): no label can be drawn, none is asked for.
          if (dev && m.cfi) call('showTranslation', [m.cfi, m.index, `dev: ${m.word}`])
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
        {toolbar}
        <button onClick={() => call('prev')}>{t('v2Reader.prev')}</button>
        <button onClick={() => call('next')}>{t('v2Reader.next')}</button>
        {annotatable && <button onClick={() => call('highlightSelection')}>{t('v2Reader.highlight')}</button>}
        <button onClick={toggleFlow} disabled={!reflowable}>{flow === 'paginated' ? t('v2Reader.scrolled') : t('v2Reader.paginated')}</button>
      </div>
      <strong data-testid="v2-heading">{heading || idleHeading}</strong>
      <span data-testid="v2-status">{status}</span>
      {dev && <span data-testid="v2-restore">{restored}</span>}
      {(frameFailed || error) && (
        <span role="alert">
          {frameFailed ? t('v2Reader.frameFailed', { path: FRAME_SRC, seconds: readyDeadlineMs / 1000 }) : error}
        </span>
      )}
      {children}
      {/* allow-same-origin is required: foliate reads its section frames' documents, and under an opaque
          origin every nested frame gets its own. So the page shares the app's origin, and the page CSP is the
          only script barrier (README "Sandbox"). A book script past it would reach this origin's localStorage
          AND its /api session cookie. The shell itself is public (it carries no data, nginx serves it to
          anyone); what is gated is the route that hands it a book, behind Features:V2Api (off in production).
          A second origin is revisited before M5 (docs/01-architecture/v2-reader-web-hosting.md). */}
      <iframe ref={frame} title="V2 reader" sandbox="allow-scripts allow-same-origin" src={FRAME_SRC} style={{ flex: 1, border: '1px solid #ccc' }} />
    </main>
  )
}
