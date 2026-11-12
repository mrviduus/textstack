import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { ApiError, isOfflineError, v2Api } from '@textstack/shared'
import { fetchV2FileBytes, pullV2Books, v2Book, v2Status } from '../api/v2'
import { SeoHead } from '../components/SeoHead'
import { V2ReaderHost, type V2HostBook } from '../components/reader/V2ReaderHost'
import { DOWNLOAD_STALL_MS, READY_DEADLINE_NETWORK_MS } from '../../../mobile/src/lib/v2reader/deadlines.mjs'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'

/**
 * `/:lang/library/my/:id/read-v2` (#1225): a V2 book in the V2 reader page, behind Features:V2Api. With V2 off
 * for this app start (the probe's answer, waited for) it is the legacy reader. Online only: the current file's
 * bytes are fetched per open (with progress) and transferred into the frame. Position and highlights: on the
 * server, through V2ReaderHost's sync (#1226). The load's failures by cause, Retry where it can help (#1227).
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
  if (v2Api.v2ErrorOf(e)?.code === 'v2_unavailable' || (e instanceof ApiError && e.status === 503)) return { error: t('v2Reader.unavailable'), retry: true }
  return { error: t('v2Reader.loadFailed', { error: e instanceof Error ? e.message : String(e) }), retry: true }
}

export function V2ReaderPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { language } = useLanguage()
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [book, setBook] = useState<V2HostBook | null>(null)
  const [load, setLoad] = useState<Load>(null)
  /** Retry (a failed load, or the host's reload after its bytes went into a frame that never answered). */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    void v2Status().then((s) => { if (live) setEnabled(s.enabled) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!enabled) return
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
    const fetchCurrent = async (fresh: boolean): Promise<V2HostBook> => {
      armStall()
      if (fresh) await orAbort(pullV2Books())
      const file = (await orAbort(v2Book(id))).currentFile
      if (!file?.hasContent) throw new NoFile()
      armStall()
      const bytes = await fetchV2FileBytes(id, file.id, (loaded, total) => {
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
        // `v2Book` answers from this session's copy of the library: a 404 or "no file" is checked against a
        // fresh pull once (the file may have been replaced) before it is said as final.
        if (abort.signal.aborted || !(e instanceof NoFile || (e instanceof ApiError && e.status === 404))) throw e
        return fetchCurrent(true)
      }
    })().then((b) => {
      if (abort.signal.aborted) return
      setLoad(null)
      setBook(b)
    }, (e: unknown) => {
      if (stalled) setLoad({ error: t('v2Reader.stalled', { seconds: DOWNLOAD_STALL_MS / 1000 }), retry: true })
      else if (!abort.signal.aborted) setLoad(loadError(e, t))
    }).finally(() => clearTimeout(stall))
    return () => {
      abort.abort()
      clearTimeout(stall)
    }
  }, [enabled, id, t, attempt])

  if (enabled === false) return <Navigate to={`/${language}/library/my/${id}/read`} replace />
  if (enabled === null) return null
  const failed = load && 'error' in load ? load : null
  const idleHeading = failed ? '' : load && 'percent' in load && load.percent !== null ? t('v2Reader.downloading', { percent: load.percent }) : t('v2Reader.loading')
  return (
    <>
      <SeoHead title={book?.name} noindex />
      <V2ReaderHost book={book} idleHeading={idleHeading} readyDeadlineMs={PROD_READY_DEADLINE_MS} backUrl={`/${language}/library`} onReload={() => setAttempt((a) => a + 1)}>
        {failed && (
          <span role="alert" data-testid="v2-load-error">
            {failed.error} {failed.retry && <button onClick={() => setAttempt((a) => a + 1)}>{t('v2Reader.retry')}</button>}
          </span>
        )}
      </V2ReaderHost>
    </>
  )
}
