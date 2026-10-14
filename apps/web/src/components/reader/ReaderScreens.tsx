import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SeoHead } from '../SeoHead'
import { LocalizedLink } from '../LocalizedLink'
import { useTranslation } from '../../hooks/useTranslation'

/** Skeleton while the chapter loads. */
export function ReaderLoadingScreen() {
  return (
    <div className="reader-page">
      <SeoHead title="Loading..." noindex />
      <div className="reader-loading">
        <div className="reader-loading__skeleton" />
        <div className="reader-loading__skeleton" />
        <div className="reader-loading__skeleton" />
      </div>
    </div>
  )
}

interface ErrorProps {
  seoTitle: string
  heading: string
  body: string
  linkTo: string
  linkText: string
  /** Catalog links are language-relative; upload links already carry the language. */
  localizedLink?: boolean
}

/** A reader that cannot show the book: sign-in required, unopenable PDF, missing chapter. */
export function ReaderErrorScreen({ seoTitle, heading, body, linkTo, linkText, localizedLink = false }: ErrorProps) {
  const ErrorLink = localizedLink ? LocalizedLink : Link
  return (
    <div className="reader-page">
      <SeoHead title={seoTitle} noindex />
      <div className="reader-error">
        <h2>{heading}</h2>
        <p>{body}</p>
        <ErrorLink to={linkTo} className="reader-error__home-link">
          {linkText}
        </ErrorLink>
      </div>
    </div>
  )
}

/**
 * The engine could not open the chapter or book (#849, #853): said inside the reader, whose bars and nav
 * stay. Try again is disabled while `onRetry` runs. The caller keeps the tries: `stillFailing` after one.
 */
export function ReaderOpenError({ onRetry, stillFailing, message = 'reader.openError.message' }: {
  onRetry: () => Promise<unknown> | void
  stillFailing: boolean
  message?: string
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await onRetry()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="reader-open-error" role="alert">
      <p>{t(message)}</p>
      {stillFailing && <p>{t('reader.openError.stillFailing')}</p>}
      <button type="button" className="reader-open-error__retry" onClick={retry} disabled={busy}>
        {t(busy ? 'reader.openError.opening' : 'reader.openError.retry')}
      </button>
    </div>
  )
}
