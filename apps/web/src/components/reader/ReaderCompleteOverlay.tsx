import { Link } from 'react-router-dom'
import { LocalizedLink } from '../LocalizedLink'

interface Props {
  bookTitle: string
  backUrl: string
  /** Catalog back URLs are language-relative; upload URLs already carry the language. */
  useLocalizedLink: boolean
  onClose: () => void
}

/** "You've finished this book" — shown after Finish book. */
export function ReaderCompleteOverlay({ bookTitle, backUrl, useLocalizedLink, onClose }: Props) {
  return (
    <div className="reader-complete-overlay" onClick={onClose}>
      <div className="reader-complete" onClick={e => e.stopPropagation()}>
        <h2>You've finished this book</h2>
        <p className="reader-complete__title">{bookTitle}</p>
        <div className="reader-complete__actions">
          {useLocalizedLink ? (
            <LocalizedLink to={backUrl} className="reader-complete__btn">
              Back to Book
            </LocalizedLink>
          ) : (
            <Link to={backUrl} className="reader-complete__btn">
              Back to Book
            </Link>
          )}
          <button
            className="reader-complete__btn reader-complete__btn--secondary"
            onClick={onClose}
          >
            Keep Reading
          </button>
        </div>
      </div>
    </div>
  )
}
