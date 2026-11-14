import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { PagePosition } from '@textstack/shared'
// ponytail: deep imports of apps/mobile source. The page and its helpers live there until the engine's home
// is settled (#1128, ADR-032); moving them on the mobile side breaks this file's tsc, visibly, not silently.
import { createOpenTracker, type Take } from '../../../../mobile/src/lib/v2reader/openTracker.mjs'
import { V2_READER_FRAME_PATH } from '../../../../mobile/src/lib/v2reader/framePath.mjs'
import { createDeadlines, openedDeadlineMs, READY_DEADLINE_MS, type Overdue } from '../../../../mobile/src/lib/v2reader/deadlines.mjs'
import { readSelection } from '../../../../mobile/src/lib/v2reader/selection.mjs'
import { createHostMoves, hidesBarsOnRelocate, keyAction, NAV_KEYS, readDir, readKey, readRelocate, readTap, takenWithoutBook, type V2NavKey } from '../../../../mobile/src/lib/v2reader/chrome.mjs'
import { popupStep, readLang, readWord, type V2Popup, type V2PopupEvent } from '../../../../mobile/src/lib/v2reader/wordPopup.mjs'
import { savesWords } from '../../../../mobile/src/lib/v2reader/vocabSave.mjs'
import { V2ReaderPopups } from './V2ReaderPopups'
import { readToc, tocAround, type V2TocEntry } from '../../../../mobile/src/lib/v2reader/toc.mjs'
import { V2SectionNav, V2TocDrawer } from './V2ReaderToc'
import { useImmersiveMode } from '../../hooks/useImmersiveMode'
import { V2TimeLeft, v2Percent, type V2TimePlace } from './V2TimeLeft'
import { useTranslation } from '../../hooks/useTranslation'
import { readItem, writeItem } from '../../lib/safeLocalStorage'
import { useV2ReaderSettings, V2ReaderSettingsDrawer } from './V2ReaderSettings'
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

type HostKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat' | 'target'>
/**
 * A keydown on the host's own document as a navigation key (#1263), or null. The page's `navKey` takes keys on
 * its document body only; here a focused bar control keeps only the keys it uses itself, so after a click on
 * Next › the arrows still turn: Space on a button or link, every key in a field. Inside a dialog, Escape only.
 * Escape always (the bars). No
 * Ctrl/Alt/Meta, no Shift+arrow (it extends a selection), as `navKey`.
 */
export function hostNavKey(e: HostKeyEvent): { key: V2NavKey; shift: boolean; repeat: boolean } | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const key = (e.key === ' ' ? 'Space' : e.key) as V2NavKey
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

interface Props {
  book: V2HostBook | null
  /** The page took a book (after the open tracker's checks): the dev route records it in its library. */
  onOpened?: (m: V2OpenedMessage, originalName: string) => void
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
}

export function V2ReaderHost({ book, onOpened, toolbar, children, idleHeading = '', readyDeadlineMs = READY_DEADLINE_MS, onReload, dev = false, backUrl }: Props) {
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
  /** The reading settings (#1260): sent whole on `ready` and on every change; the theme colours the bars. */
  const { settings, update: updateSettings } = useV2ReaderSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The direction the open book pages in (`opened`, then every `relocate`): the arrow keys follow it. */
  const pageDir = useRef<'ltr' | 'rtl'>('ltr')
  /** `opened.annotatable`: false on a CBZ (images only) and a PDF (no highlights yet): no highlight button (the page refuses it too). */
  const [annotatable, setAnnotatable] = useState(true)
  /** False for a fixed-layout book (CBZ): flow changes nothing there. */
  const [reflowable, setReflowable] = useState(true)
  /** The percent read, of the last relocate shown ('' : none); the current contents entry's title is added where it is drawn. */
  const [status, setStatus] = useState('')
  /** The place of the relocate `status` shows, for the time left (#1262). */
  const [timePlace, setTimePlace] = useState<V2TimePlace | null>(null)
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
  /**
   * The open book's contents (#1261, toc.mjs) and the reader's place in them; shown only while `reading`. The
   * place is cleared where an open starts, not on `opened`: the page posts a book's first relocate before its
   * `opened`, and a fixed-layout book sends no other until a page turn.
   */
  const [toc, setToc] = useState<V2TocEntry[]>([])
  const [tocIndex, setTocIndex] = useState<number | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
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
  const { immersiveMode: barsHidden, showBars, hideBars } = useImmersiveMode(true, !reading)
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
  const [popup, setPopupState] = useState<V2Popup | null>(null)
  const popupRef = useRef<V2Popup | null>(null)
  const setPopup = (p: V2Popup | null) => {
    popupRef.current = p
    setPopupState(p)
  }
  const [bookLanguage, setBookLanguage] = useState('en')
  /** The server book a tapped word is saved with (#1270): the production route's, when the bytes are its file's. */
  const [vocabBook, setVocabBook] = useState<{ id: string; title: string } | null>(null)
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
  const onPopupEvent = (e: V2PopupEvent) => {
    const { popup: next, turn } = popupStep(popupRef.current, e, { width: frame.current?.clientWidth, flow: effectiveFlow(), dir: pageDir.current })
    setPopup(next)
    if (turn === 'toggle') return barsHiddenRef.current ? showBars() : hideBars()
    if (!turn) return
    call(turn)
    hideBars()
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
    setTocIndex(null)
    setTocOpen(false)
    setPopup(null)
    setRestored('')
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
    // A fresh frame has no book on screen.
    setReading(false)
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
      // A language that does not read (`deu`) saves nothing: the fallback `en` would file its words under English cards.
      setVocabBook(!dev && target && target.sha256.toLowerCase() === m.book.sha256 && savesWords(m) ? { id: target.bookId, title: m.title || current.originalName } : null)
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
      // Untrusted: only what readToc takes. Its place came with the relocate before this message.
      setToc(readToc(m))
      setBookLanguage(readLang(m) ?? 'en')
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
          // The stored layout before the first open: messages arrive in order, and a setting is not a switch.
          call('flow', [flowRef.current])
          call('settings', [settingsRef.current])
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
          setTocIndex(r.tocIndex)
          setTimePlace({ fraction: r.fraction, sectionEnd: r.sectionEnd, words: r.words })
          setStatus(v2Percent(r.fraction))
          return
        }
        case 'tap': {
          // A press that dismissed a selection sends no `tap`, a link none either. Untrusted: only what readTap
          // takes. Page-viewport px = this frame's.
          const p = readTap(m)
          if (p) onPopupEvent({ type: 'tap', x: p.x })
          return
        }
        case 'word': {
          // #1269: an edge word in paginated flow turns the page, any other opens its popup (popupStep). Untrusted:
          // only what readWord takes.
          const w = readWord(m)
          if (!w) return
          // Dev stub: the label proves the word → showTranslation round trip (no CFI: none).
          if (dev && w.cfi) call('showTranslation', [w.cfi, w.index, `dev: ${w.word}`])
          onPopupEvent({ type: 'word', word: w })
          return
        }
        case 'key': {
          // A key pressed in the page (its frames keep focus): only what readKey takes.
          onNavKey(readKey(m))
          return
        }
        case 'selection': {
          // Untrusted (the page renders the book): only what readSelection takes; a malformed one is dropped.
          const s = readSelection(m)
          if (s) onPopupEvent({ type: 'selection', selection: s })
          return
        }
        case 'selection-cleared':
          onPopupEvent({ type: 'selection-cleared' })
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
    const onVisibility = () => { if (document.visibilityState === 'hidden') void sync.current?.flush() }
    // The page's last turn (#1286): its own pagehide `store` would reach a document that is unloading; taken here first.
    const onPageHide = () => {
      const last = storeFor(pageLastStore(frame.current))
      sync.current?.flushKeepalive(last)
    }
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

  // Leaving the route (#1286): the page's last turn, taken while the frame is still in the document (a layout
  // cleanup runs before React removes it; the passive one below it, after). The session's close joins it.
  useLayoutEffect(() => () => {
    const last = storeFor(pageLastStore(frame.current))
    void sync.current?.close(last)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (onNavKey(hostNavKey(e), e.target instanceof Element && !!e.target.closest('.word-popup'))) e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  // Hidden bars keep no focus: an invisible control must not be activated by a key.
  useEffect(() => {
    const at = document.activeElement
    if (barsHidden && at && (header.current?.contains(at) || footer.current?.contains(at))) main.current?.focus({ preventScroll: true })
  }, [barsHidden])

  // Applied live: the page re-lays the book out where it is (README, `settings`).
  useEffect(() => {
    if (ready.current) call('settings', [settings])
  }, [settings])
  /**
   * A contents entry the reader chose (the dialog, the section controls). Chosen: the page saves where it lands
   * (README, `goTo`). It is the current one at once: a jump within the view on screen may send no relocate.
   */
  const goToc = (e: V2TocEntry) => {
    setTocIndex(e.index)
    hostMove('goTo', [e.href, true])
  }
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
    <main ref={main} tabIndex={-1} className={`reader-page v2-reader${barsHidden ? ' immersive-mode' : ''}`} data-bars={barsHidden ? 'hidden' : 'shown'}>
      {/* Legacy reader's bars (reader.css); hidden ones stay reachable by Tab, and focus shows them. */}
      <header ref={header} className="reader-top-bar" onFocus={showBars}>
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
          {reading && toc.length > 0 && <button className="reader-top-bar__btn" onClick={() => setTocOpen(true)}>{t('v2Reader.contents')}</button>}
          {annotatable && (dev || highlightsReady) && <button className="reader-top-bar__btn" onClick={() => call('highlightSelection')}>{t('v2Reader.highlight')}</button>}
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
      <div className="v2-reader__notices">
        {saveStatus !== 'saved' && (
          <span role="status" data-testid="v2-not-saved">{t(SAVE_MESSAGE[saveStatus])}</span>
        )}
        {offer && (
          <div role="status" aria-label={t('v2Reader.newerPlaceLabel')} data-testid="v2-newer-place">
            {t('v2Reader.newerPlace', { percent: Math.round((offer.fraction ?? 0) * 100) })}{' '}
            <button onClick={() => setOffer(null)}>{t('v2Reader.stayHere')}</button>{' '}
            {/* Chosen: the page saves where it lands (README, `goTo`). */}
            <button onClick={() => { hostMove('goTo', [offer, true]); setOffer(null) }}>{t('v2Reader.goThere')}</button>
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
      </div>
      {/* allow-same-origin is required: foliate reads its section frames' documents, and under an opaque
          origin every nested frame gets its own. So the page shares the app's origin, and the page CSP is the
          only script barrier (README "Sandbox"). A book script past it would reach this origin's localStorage
          AND its /api session cookie. The shell itself is public (it carries no data, nginx serves it to
          anyone); what is gated is the route that hands it a book, behind Features:V2Api (off in production).
          A second origin is revisited before M5 (docs/01-architecture/v2-reader-web-hosting.md). */}
      <iframe key={frameLoad} ref={frame} title="V2 reader" sandbox="allow-scripts allow-same-origin" src={FRAME_SRC} className="v2-reader__frame" />
      <footer ref={footer} className="reader-footer" onFocus={showBars}>
        {reading && <V2SectionNav toc={toc} tocIndex={tocIndex} onGo={goToc} />}
        <div className="reader-footer__info v2-reader__footer">
          <button className="reader-top-bar__btn" onClick={() => hostMove('prev')}>{t('v2Reader.prev')}</button>
          <span className="reader-footer__counter" data-testid="v2-status">{statusLine}</span>
          {status && timePlace && <V2TimeLeft {...timePlace} />}
          <button className="reader-top-bar__btn" onClick={() => hostMove('next')}>{t('v2Reader.next')}</button>
        </div>
      </footer>
      {reading && (
        // Keyed: the legacy translation hooks take their languages once, at mount.
        <V2ReaderPopups
          key={bookLanguage}
          popup={popup}
          frame={frame}
          bookLanguage={bookLanguage}
          bookId={vocabBook?.id}
          bookTitle={vocabBook?.title}
          onHighlight={annotatable && (dev || highlightsReady) ? () => call('highlightSelection') : undefined}
          onClose={closePopup}
        />
      )}
      <V2ReaderSettingsDrawer open={settingsOpen} settings={settings} onUpdate={updateSettings} onClose={() => setSettingsOpen(false)} typography={reflowable} />
      <V2TocDrawer open={tocOpen && reading} toc={toc} tocIndex={tocIndex} onGo={goToc} onClose={() => setTocOpen(false)} />
    </main>
  )
}
