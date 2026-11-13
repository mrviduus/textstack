import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PagePosition } from '@textstack/shared'
// ponytail: deep imports of apps/mobile source. The page and its helpers live there until the engine's home
// is settled (#1128, ADR-032); moving them on the mobile side breaks this file's tsc, visibly, not silently.
import { createOpenTracker, type Take } from '../../../../mobile/src/lib/v2reader/openTracker.mjs'
import { V2_READER_FRAME_PATH } from '../../../../mobile/src/lib/v2reader/framePath.mjs'
import { createDeadlines, openedDeadlineMs, READY_DEADLINE_MS, type Overdue } from '../../../../mobile/src/lib/v2reader/deadlines.mjs'
import { readSelection } from '../../../../mobile/src/lib/v2reader/selection.mjs'
import { useTranslation } from '../../hooks/useTranslation'
import { readItem, writeItem } from '../../lib/safeLocalStorage'
import { createV2ReaderSync, type V2ReaderSync, type V2SaveStatus, type V2SyncTarget } from '../../lib/v2ReaderSync'

/**
 * The V2 reader page (ADR-029) on the web: one host for the dev route (/dev/reader-v2, a picked file) and the
 * production route (/:lang/library/my/:id/read-v2, the V2 file's bytes), #1225. It drives the contract the
 * Android host drives (apps/mobile/src/lib/v2reader/README.md): ready → openBytes → opened → restore → restored,
 * then store / relocate / word / openLink. Reader data (position, highlights): in localStorage on the dev route
 * (`dev`) only; on the production route on the server, for a book with a `sync` target (#1226:
 * lib/v2ReaderSync.ts; its one local exception, a CBZ page position, is named there; another device's newer place
 * is offered, #1232). The layout is a
 * localStorage setting on both.
 */

/**
 * A book to open: a new object opens it (the same object again does nothing). `bytes` are transferred. `sync`:
 * the server book and file these bytes are; its reader data is restored from and saved to the server.
 */
export interface V2HostBook { bytes: ArrayBuffer; name: string; sync?: V2SyncTarget }
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
/** The save line per sync status ('saved' shows none). */
const SAVE_MESSAGE = { unsaved: 'v2Reader.unsaved', reopen: 'v2Reader.reopen', noHighlights: 'v2Reader.noHighlights' } as const

/**
 * The page as its own same-origin document (#1219): a no-store shell with a fresh nonce per response and the
 * page code as a cached script (frame.mjs; the dev/preview servers through vite.config.ts, nginx in
 * production). Not srcdoc: that inherits this document's CSP, which refuses the page's scripts.
 */
const FRAME_SRC = V2_READER_FRAME_PATH
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
type Opening = { name: string; originalName: string; bytes?: ArrayBuffer; sync?: V2SyncTarget }

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
  /**
   * Retry after a deadline reloads the frame; an open whose bytes already went into the old frame is gone with
   * it, and this asks the route for the book again (a new object). Without it (the dev route) the reader picks again.
   */
  onReload?: () => void
  /** The dev route: reader data in localStorage, the `restore:` line and a stub translation label on a tapped word. */
  dev?: boolean
}

export function V2ReaderHost({ book, onOpened, toolbar, children, idleHeading = '', readyDeadlineMs = READY_DEADLINE_MS, onReload, dev = false }: Props) {
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
  const onReloadRef = useRef(onReload)
  onReloadRef.current = onReload
  /** null: `idleHeading` (nothing opened, or the open was given up); '' after a failed open: no title of another book (#1168). */
  const [heading, setHeading] = useState<string | null>(null)
  const [flow, setFlow] = useState<Flow>(() => (readItem(FLOW_KEY) === 'scrolled' ? 'scrolled' : 'paginated'))
  const flowRef = useRef(flow)
  /** `opened.annotatable`: false on a CBZ (images only) and a PDF (no highlights yet): no highlight button (the page refuses it too). */
  const [annotatable, setAnnotatable] = useState(true)
  /** False for a fixed-layout book (CBZ): flow changes nothing there. */
  const [reflowable, setReflowable] = useState(true)
  const [status, setStatus] = useState('')
  const [restored, setRestored] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** A deadline the frame missed (deadlines.mjs); a late answer clears it. */
  const [overdue, setOverdue] = useState<Overdue>(null)
  const [deadlines] = useState(() => createDeadlines(setOverdue))
  /** The size of the open last handed to the page: its `opened` deadline (said in the message). */
  const openedBytes = useRef(0)
  /** A new value is a new frame (Retry after a deadline). */
  const [frameLoad, setFrameLoad] = useState(0)
  /** The open book's server sync (null: none, or the dev route); one per take, closed (after a last write) on the next. */
  const sync = useRef<V2ReaderSync | null>(null)
  const [saveStatus, setSaveStatus] = useState<V2SaveStatus>('saved')
  /** The production route: the server's highlights have landed, so highlighting is offered (B, #1226). */
  const [highlightsReady, setHighlightsReady] = useState(false)
  /** The open's reading-state read failed: no session; Retry reads again, then restores (no read, no writes). */
  const [readFailed, setReadFailed] = useState(false)
  const retryRead = useRef<(() => void) | null>(null)
  /** Another device's newer place, offered (#1232, ADR-019 `prompt`); the newest one shown until answered or a new open. */
  const [offer, setOffer] = useState<PagePosition | null>(null)

  const call = (name: string, args: unknown[] = [], transfer: Transferable[] = []) =>
    frame.current?.contentWindow?.postMessage({ call: name, args }, location.origin, transfer)
  const flushOpen = () => {
    const o = opening.current
    if (!ready.current || !o?.bytes) return
    openedBytes.current = o.bytes.byteLength
    deadlines.waitOpened(o.bytes.byteLength)
    call('openBytes', [o.bytes, o.name], [o.bytes])
    o.bytes = undefined
  }

  useEffect(() => {
    // The same object again (a re-render, StrictMode's second run) is not a new open: its bytes may be gone.
    if (!book || book === lastBook.current) return
    lastBook.current = book
    // Nothing of the previous book may stay on screen beside this one's answer (or its error).
    setError(null)
    setOffer(null)
    setHeading(t('v2Reader.opening', { name: book.name }))
    setStatus('')
    setRestored('')
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
    const takeOpened = ({ open: current, opened: m }: Take<Opening, V2OpenedMessage>) => {
      opening.current = current
      // The previous take's last writes go out; a later open of the same book reads after them (v2ReaderSync), another never waits.
      void sync.current?.close()
      sync.current = null
      retryRead.current = null
      setSaveStatus('saved')
      setHighlightsReady(false)
      setReadFailed(false)
      const target = current.sync
      if (dev) call('restore', [readItem(storeKey(m.book.sha256))])
      else if (!target) call('restore', [null])
      else if (target.sha256.toLowerCase() !== m.book.sha256) {
        // Bytes that are not the server file's: nothing of that book's data is theirs, and nothing is saved.
        console.warn(`[v2] opened bytes ${m.book.sha256} are not file ${target.fileId}: not synced`)
        setSaveStatus('unsaved')
        call('restore', [null])
      } else {
        const s = createV2ReaderSync(target, {
          onStatus: setSaveStatus,
          // Drawn without moving the reader; highlighting is offered from now on.
          onHighlights: (list) => {
            setHighlightsReady(true)
            if (list.length) call('addHighlights', [list])
          },
          highlights: m.annotatable !== false,
          // A later offer replaces the one shown (the newest place).
          onNewerPlace: setOffer,
        })
        sync.current = s
        // Only while this take is the open one: a later take closed `s`, and its answers are none of this book's.
        const read = () => {
          setReadFailed(false)
          s.restore().then((json) => {
            if (sync.current !== s || json === null) return
            call('restore', [json])
            void s.loadHighlights()
          }, (e: unknown) => {
            console.warn('[v2] reading state not read:', e)
            if (sync.current === s) setReadFailed(true)
          })
        }
        retryRead.current = read
        read()
      }
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
          deadlines.ready()
          // The stored layout before the first open: messages arrive in order, and a setting is not a switch.
          call('flow', [flowRef.current])
          ready.current = true
          flushOpen()
          return
        case 'opened': {
          const take = tracker.opened(m)
          if (!take) return
          deadlines.answered()
          takeOpened(take)
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
          for (const h of m.highlights ?? []) if (h.status !== 'restored') console.warn(`[v2] highlight ${h.id} not drawn: ${h.status}`)
          return
        case 'restored':
          // Only for the book taken last: a stale answer must not show another book as restored.
          if (!tracker.restored(m)) return
          setRestored(t('v2Reader.restore', { state: String(m.position) }))
          return
        case 'store':
          // Keyed on the route: the production route never keeps reader data in this browser (the server
          // only; a store for another book than the synced one is a previous open's, dropped).
          if (dev) writeItem(storeKey(m.key), m.json)
          else if (sync.current && m.key === sync.current.target.sha256) sync.current.store(m.json)
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
        case 'selection': {
          // Untrusted (the page renders the book): only what readSelection takes; a malformed one is dropped.
          // No toolbar in this slice (#1268): the dev route logs it, the production route takes it no further.
          const s = readSelection(m)
          if (s && dev) console.log(`[v2] selection ${s.text.length} chars, section ${s.index}`)
          return
        }
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
    const onVisibility = () => { if (document.visibilityState === 'hidden') void sync.current?.flush() }
    const onPageHide = () => sync.current?.flushKeepalive()
    document.addEventListener('visibilitychange', onVisibility)
    addEventListener('pagehide', onPageHide)
    return () => {
      removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onVisibility)
      removeEventListener('pagehide', onPageHide)
      // Leaving the route (SPA navigation): the session's last pass still writes what is unsaved.
      void sync.current?.close()
      sync.current = null
    }
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
        {annotatable && (dev || highlightsReady) && <button onClick={() => call('highlightSelection')}>{t('v2Reader.highlight')}</button>}
        <button onClick={toggleFlow} disabled={!reflowable}>{flow === 'paginated' ? t('v2Reader.scrolled') : t('v2Reader.paginated')}</button>
      </div>
      <strong data-testid="v2-heading">{heading ?? idleHeading}</strong>
      <span data-testid="v2-status">{status}</span>
      {saveStatus !== 'saved' && (
        <span role="status" data-testid="v2-not-saved">{t(SAVE_MESSAGE[saveStatus])}</span>
      )}
      {offer && (
        <div role="status" aria-label={t('v2Reader.newerPlaceLabel')} data-testid="v2-newer-place">
          {t('v2Reader.newerPlace', { percent: Math.round((offer.fraction ?? 0) * 100) })}{' '}
          <button onClick={() => setOffer(null)}>{t('v2Reader.stayHere')}</button>{' '}
          {/* Chosen: the page saves where it lands (README, `goTo`). */}
          <button onClick={() => { call('goTo', [offer, true]); setOffer(null) }}>{t('v2Reader.goThere')}</button>
        </div>
      )}
      {readFailed && (
        <span role="alert" data-testid="v2-read-failed">
          {t('v2Reader.readFailed')} <button onClick={() => retryRead.current?.()}>{t('v2Reader.retry')}</button>
        </span>
      )}
      {dev && <span data-testid="v2-restore">{restored}</span>}
      {overdue && (
        <span role="alert" data-testid="v2-overdue">
          {overdue === 'ready'
            ? t('v2Reader.frameFailed', { path: FRAME_SRC, seconds: readyDeadlineMs / 1000 })
            : t('v2Reader.openTimeout', { name: opening.current?.originalName ?? '', seconds: Math.ceil(openedDeadlineMs(openedBytes.current) / 1000) })}{' '}
          <button onClick={reloadFrame}>{t('v2Reader.retry')}</button>
        </span>
      )}
      {error && <span role="alert">{error}</span>}
      {children}
      {/* allow-same-origin is required: foliate reads its section frames' documents, and under an opaque
          origin every nested frame gets its own. So the page shares the app's origin, and the page CSP is the
          only script barrier (README "Sandbox"). A book script past it would reach this origin's localStorage
          AND its /api session cookie. The shell itself is public (it carries no data, nginx serves it to
          anyone); what is gated is the route that hands it a book, behind Features:V2Api (off in production).
          A second origin is revisited before M5 (docs/01-architecture/v2-reader-web-hosting.md). */}
      <iframe key={frameLoad} ref={frame} title="V2 reader" sandbox="allow-scripts allow-same-origin" src={FRAME_SRC} style={{ flex: 1, border: '1px solid #ccc' }} />
    </main>
  )
}
