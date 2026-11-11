import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { fetchV2FileBytes, v2Book, v2Status } from '../api/v2'
import { SeoHead } from '../components/SeoHead'
import { V2ReaderHost, type V2HostBook } from '../components/reader/V2ReaderHost'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'

/**
 * `/:lang/library/my/:id/read-v2` (#1225): a V2 book in the V2 reader page, behind Features:V2Api. With V2 off
 * for this app start (the probe's answer, waited for) it is the legacy reader. Online only: the current file's
 * bytes are fetched per open and transferred into the frame. Position and highlights: V2ReaderHost's local
 * store until the sync slice (#1226); loading and error states beyond one line: #1227.
 */
export const PROD_READY_DEADLINE_MS = 30_000

export function V2ReaderPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { language } = useLanguage()
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [book, setBook] = useState<V2HostBook | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void v2Status().then((s) => { if (live) setEnabled(s.enabled) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let live = true
    setError(null)
    ;(async () => {
      const file = (await v2Book(id)).currentFile
      if (!file?.hasContent) throw new Error(t('v2Reader.noFile'))
      const bytes = await fetchV2FileBytes(id, file.id)
      if (live) setBook({ bytes, name: file.originalName })
    })().catch((e: unknown) => {
      if (live) setError(t('v2Reader.loadFailed', { error: e instanceof Error ? e.message : String(e) }))
    })
    return () => { live = false }
  }, [enabled, id, t])

  if (enabled === false) return <Navigate to={`/${language}/library/my/${id}/read`} replace />
  if (enabled === null) return null
  return (
    <>
      <SeoHead title={book?.name} noindex />
      {/* 30 s: the first open fetches the 1.6 MB (gzip) page script over the network; real deadlines: #1227. */}
      <V2ReaderHost book={book} idleHeading={error ? '' : t('v2Reader.loading')} readyDeadlineMs={PROD_READY_DEADLINE_MS}>
        {error && <span role="alert" data-testid="v2-load-error">{error}</span>}
      </V2ReaderHost>
    </>
  )
}
