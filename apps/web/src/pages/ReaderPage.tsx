import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ApiError, isOfflineError, OPENED_AT_KEY, syncApi, withOpened } from '@textstack/shared'
import { readItem, writeItem } from '../lib/safeLocalStorage'
import { fetchFileBytes, pullBooks, syncAnswer, liveBook, syncSwitch } from '../api/sync'
import { SeoHead } from '../components/SeoHead'
import { ReaderHost, type HostBook } from '../components/reader/ReaderHost'
import { DOWNLOAD_STALL_MS, READY_DEADLINE_NETWORK_MS } from '../../../../packages/reader/src/deadlines.mjs'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'

/**
 * `/:lang/library/my/:id/read[/:chapterSlug]` and `/read-v2` (#1225, M5 #1031): a V2 book in the V2 reader page,
 * the reader once the session is settled (the probe, waited for). Online only: the current file's
 * bytes are fetched per open (with progress) and transferred into the frame. Position and highlights: on the
 * server, through ReaderHost's sync (#1226). The load's failures by cause, Retry where it can help (#1227).
 */
export const PROD_READY_DEADLINE_MS = READY_DEADLINE_NETWORK_MS
export const STALL_GRACE_MS = 1000

class NoFile extends Error {}

type Load = { percent: number | null } | { error: string; retry: boolean } | null

/** A failed load as the reader reads it: the cause, and whether trying again can help. */
function loadError(e: unknown, t: (key: string, vars?: Record<string, string | number>) => string): { error: string; retry: boolean } {
  if (e instanceof NoFile) return { error: t('v2Reader.noFile'), retry: false }
  if (isOfflineError(e)) return { error: t('v2Reader.offline'), retry: true }
  if (e instanceof ApiError && e.status === 401) return { error: t('v2Reader.sessionEnded'), retry: false }
  if (e instanceof ApiError && e.status === 404) return { error: t('v2Reader.gone'), retry: false }
  if (syncApi.syncErrorOf(e)?.code === 'v2_unavailable' || (e instanceof ApiError && e.status === 503)) return { error: t('v2Reader.unavailable'), retry: true }
  return { error: t('v2Reader.loadFailed', { error: e instanceof Error ? e.message : String(e) }), retry: true }
}

export function ReaderPage() {
  const { id = '' } = useParams<{ id: string }>()
  // #1312: a link to one highlight (the highlights page, audit §2.1): the book jumps there once it is drawn.
  const [search, setSearch] = useSearchParams()
  /** Once jumped there, the link's parameter goes (replaced, no history entry): a reload reopens at the saved place. */
  const dropParam = (name: string) => setSearch((p) => { const n = new URLSearchParams(p); n.delete(name); return n }, { replace: true })
  const highlightShown = () => dropParam('highlight')
  const { language } = useLanguage()
  const { t } = useTranslation()
  // The session is settled at once when this start has a probe answer (an in-app open); else waited for (a cold load).
  const [ready, setReady] = useState(() => syncAnswer() !== null)
  const [book, setBook] = useState<HostBook | null>(null)
  const [load, setLoad] = useState<Load>(null)
  /** Retry (a failed load, or the host's reload after its bytes went into a frame that never answered). */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    void syncSwitch().then(() => { if (live) setReady(true) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!ready) return
    // Unmount, another book, Retry: the download in flight stops (its bytes would be nobody's).
    const abort = new AbortController()
    let stalled = false
    let stall: ReturnType<typeof setTimeout> | undefined
    // After a frozen tab the due timer can run before the chunks that arrived meanwhile: one grace second,
    // which a chunk's `armStall` cancels.
    const armStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => { stall = setTimeout(() => { stalled = true; abort.abort() }, STALL_GRACE_MS) }, DOWNLOAD_STALL_MS)
    }
    /** The library calls take no signal: their wait ends with the abort (the stall, unmount, Retry). */
    const orAbort = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => {
      abort.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })])
    setLoad({ percent: null })
    const fetchCurrent = async (fresh: boolean): Promise<HostBook> => {
      armStall()
      if (fresh) await orAbort(pullBooks())
      const file = (await orAbort(liveBook(id))).currentFile
      if (!file?.hasContent) throw new NoFile()
      armStall()
      const bytes = await fetchFileBytes(id, file.id, (loaded, total) => {
        armStall()
        if (!total) return
        // Content-Length may be off (a proxy's encoding): never past 99 % before the bytes are all in.
        const percent = Math.min(99, Math.floor((loaded / total) * 100))
        setLoad((l) => (l && 'percent' in l && l.percent === percent ? l : { percent }))
      }, abort.signal)
      // The reader data of this file goes to and comes from the server (#1226).
      const sync = { bookId: id, fileId: file.id, format: file.format, sha256: file.sha256, size: file.byteSize, name: file.originalName }
      return { bytes, name: file.originalName, sync }
    }
    ;(async () => {
      try {
        return await fetchCurrent(false)
      } catch (e) {
        // `liveBook` answers from this session's copy of the library: a 404 or "no file" is checked against a
        // fresh pull once (the file may have been replaced) before it is said as final.
        if (abort.signal.aborted || !(e instanceof NoFile || (e instanceof ApiError && e.status === 404))) throw e
        return fetchCurrent(true)
      }
    })().then((b) => {
      if (abort.signal.aborted) return
      setLoad(null)
      setBook(b)
      // This device opened it: "Recently opened" sorts it first, with no server write (a reopen moves no place).
      writeItem(OPENED_AT_KEY, withOpened(readItem(OPENED_AT_KEY), id))
    }, (e: unknown) => {
      if (stalled) setLoad({ error: t('v2Reader.stalled', { seconds: DOWNLOAD_STALL_MS / 1000 }), retry: true })
      else if (!abort.signal.aborted) setLoad(loadError(e, t))
    }).finally(() => clearTimeout(stall))
    return () => {
      abort.abort()
      clearTimeout(stall)
    }
  }, [ready, id, t, attempt])

  if (!ready) return null
  const failed = load && 'error' in load ? load : null
  const idleHeading = failed ? '' : load && 'percent' in load && load.percent !== null ? t('v2Reader.downloading', { percent: load.percent }) : t('v2Reader.loading')
  return (
    <>
      {/* Never indexed; a title before the book's name is known (#1267). */}
      <SeoHead title={book?.name ?? t('v2Reader.title')} noindex />
      <ReaderHost book={book} highlightId={search.get('highlight')} onHighlightShown={highlightShown} openContents={search.get('contents') === '1'} onContentsShown={() => dropParam('contents')} idleHeading={idleHeading} readyDeadlineMs={PROD_READY_DEADLINE_MS} backUrl={`/${language}/library`} onReload={() => setAttempt((a) => a + 1)}>
        {failed && (
          <span role="alert" data-testid="v2-load-error">
            {failed.error} {failed.retry && <button onClick={() => setAttempt((a) => a + 1)}>{t('v2Reader.retry')}</button>}
          </span>
        )}
      </ReaderHost>
    </>
  )
}
