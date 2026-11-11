import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { ApiError, isOfflineError, v2Api } from '@textstack/shared'
import { fetchV2FileBytes, v2Book, v2Status } from '../api/v2'
import { SeoHead } from '../components/SeoHead'
import { V2ReaderHost, type V2HostBook } from '../components/reader/V2ReaderHost'
import { READY_DEADLINE_NETWORK_MS } from '../../../mobile/src/lib/v2reader/deadlines.mjs'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'

/**
 * `/:lang/library/my/:id/read-v2` (#1225): a V2 book in the V2 reader page, behind Features:V2Api. With V2 off
 * for this app start (the probe's answer, waited for) it is the legacy reader. Online only: the current file's
 * bytes are fetched per open (with progress) and transferred into the frame. Position and highlights: on the
 * server, through V2ReaderHost's sync (#1226). The load's failures by cause, Retry where it can help (#1227).
 */
export const PROD_READY_DEADLINE_MS = READY_DEADLINE_NETWORK_MS

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
    let live = true
    setLoad({ percent: null })
    ;(async () => {
      const file = (await v2Book(id)).currentFile
      if (!file?.hasContent) throw new NoFile()
      const bytes = await fetchV2FileBytes(id, file.id, (loaded, total) => {
        // Content-Length may be off (a proxy's encoding): never past 99 % before the bytes are all in.
        if (live && total) setLoad({ percent: Math.min(99, Math.floor((loaded / total) * 100)) })
      })
      // The reader data of this file goes to and comes from the server (#1226).
      const sync = { bookId: id, fileId: file.id, format: file.format, sha256: file.sha256, size: file.byteSize, name: file.originalName }
      if (!live) return
      setLoad(null)
      setBook({ bytes, name: file.originalName, sync })
    })().catch((e: unknown) => {
      if (live) setLoad(loadError(e, t))
    })
    return () => { live = false }
  }, [enabled, id, t, attempt])

  if (enabled === false) return <Navigate to={`/${language}/library/my/${id}/read`} replace />
  if (enabled === null) return null
  const failed = load && 'error' in load ? load : null
  const idleHeading = failed ? '' : load && 'percent' in load && load.percent !== null ? t('v2Reader.downloading', { percent: load.percent }) : t('v2Reader.loading')
  return (
    <>
      <SeoHead title={book?.name} noindex />
      <V2ReaderHost book={book} idleHeading={idleHeading} readyDeadlineMs={PROD_READY_DEADLINE_MS} onReload={() => setAttempt((a) => a + 1)}>
        {failed && (
          <span role="alert" data-testid="v2-load-error">
            {failed.error} {failed.retry && <button onClick={() => setAttempt((a) => a + 1)}>{t('v2Reader.retry')}</button>}
          </span>
        )}
      </V2ReaderHost>
    </>
  )
}
