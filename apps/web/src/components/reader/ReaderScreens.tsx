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

/** The engine could not open the chapter (#849, #853): said inside the reader, whose bars and nav stay. */
export function ReaderOpenError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="reader-open-error" role="alert">
      <p>{t('reader.openError.message')}</p>
      <button type="button" className="reader-open-error__retry" onClick={onRetry}>{t('reader.openError.retry')}</button>
    </div>
  )
}
