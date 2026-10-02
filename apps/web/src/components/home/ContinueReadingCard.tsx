import { useTranslation } from '../../hooks/useTranslation'
import { getUserBookCoverUrl } from '../../api/userBooks'
import { getStorageUrl } from '../../api/client'
import { LocalizedLink } from '../LocalizedLink'
import type { LibraryShelfItem } from '@textstack/shared'

interface ContinueReadingCardProps {
  book: LibraryShelfItem
}

export function ContinueReadingCard({ book }: ContinueReadingCardProps) {
  const { t } = useTranslation()

  const percent = Math.round(book.progressPercent * 100)
  const isUpload = book.type === 'userbook'
  const coverUrl = isUpload ? getUserBookCoverUrl(book.coverPath) : getStorageUrl(book.coverPath)
  // No chapter (chapterless PDF in Original layout) → open the book at its saved position.
  const slug = book.chapterSlug ? `/${book.chapterSlug}` : ''
  const readerPath = isUpload ? `/library/my/${book.id}/read${slug}` : `/books/${book.slug}${slug}`
  const title = book.title

  return (
    <LocalizedLink to={readerPath} className="continue-reading__card">
      {coverUrl ? (
        <img src={coverUrl} alt="" className="continue-reading__cover" loading="lazy" />
      ) : (
        <div className="continue-reading__cover-placeholder">📖</div>
      )}
      <div className="continue-reading__info">
        <span className="continue-reading__label">{t('home.continueReading.label')}</span>
        <span className="continue-reading__title">{title}</span>
        <div className="continue-reading__progress-row">
          <div className="continue-reading__progress-bar">
            <div className="continue-reading__progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="continue-reading__percent">{percent}%</span>
        </div>
      </div>
      <span className="continue-reading__btn">▶</span>
    </LocalizedLink>
  )
}
