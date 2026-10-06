import { Link } from 'react-router-dom'
import { SeoHead } from '../SeoHead'
import { LocalizedLink } from '../LocalizedLink'

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
