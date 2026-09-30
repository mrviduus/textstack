import { isReviewableChapter } from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'
import { chapterReviewPath } from '../../hooks/useBookReviews'
import { LocalizedLink } from '../LocalizedLink'
import { ReviewChapterButton } from './ReviewChapterButton'

/**
 * The right-hand end of a chapter row: "✓ Reviewed →" to the summary when the chapter has a review,
 * otherwise a small Review button. A sibling of the row's reader link, never inside it — a button
 * inside an <a> is invalid and its click would also navigate.
 */
interface Props {
  book: { title: string; author?: string | null } & ({ userBookId: string } | { editionId: string; bookSlug: string })
  chapter: { slug: string; title: string; wordCount?: number | null }
  reviewed: boolean
}

export function ChapterReviewAction({ book, chapter, reviewed }: Props) {
  const { t } = useTranslation()

  if (reviewed) {
    const to = 'userBookId' in book
      ? chapterReviewPath({ userBookId: book.userBookId }, chapter.slug)
      : chapterReviewPath({ bookSlug: book.bookSlug }, chapter.slug)
    return (
      <LocalizedLink
        to={to}
        className="chapter-review-action chapter-review-action--done"
        aria-label={t('chapterReview.openReviewAria', { title: chapter.title })}
      >
        ✓ {t('chapterReview.reviewed')} →
      </LocalizedLink>
    )
  }

  // Front/back matter and thin chapters get no Review button (a reviewed one keeps its link above).
  if (!isReviewableChapter(chapter)) return null

  return (
    <ReviewChapterButton
      title={book.title}
      author={book.author}
      {...('userBookId' in book ? { bookId: book.userBookId } : { editionId: book.editionId })}
      chapterSlug={chapter.slug}
      chapterTitle={chapter.title}
    />
  )
}
