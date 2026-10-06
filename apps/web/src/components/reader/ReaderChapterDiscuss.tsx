import { isReviewableChapter } from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'
import { LocalizedLink } from '../LocalizedLink'
import { ReviewChapterButton } from '../library/ReviewChapterButton'

interface Props {
  chapter: { identifier: string; title: string; wordCount: number | null }
  /** The chapter already has a saved review. */
  reviewed: boolean
  reviewPath: string
  bookTitle: string
  author: string | null
  /** Upload id, or the catalog edition id + slug. */
  book: { bookId?: string; editionId?: string; slug?: string }
}

/**
 * End-of-chapter Discuss (chapter-review.md §12): the saved review, or the launcher.
 * Signed-in only, like the chapter-row action — the caller gates it, because the
 * launcher fetches grants on mount (a 401 for every anonymous reader).
 */
export function ReaderChapterDiscuss({ chapter, reviewed, reviewPath, bookTitle, author, book }: Props) {
  const { t } = useTranslation()
  if (reviewed) {
    return (
      <div className="reader-discuss">
        <LocalizedLink to={reviewPath} className="chapter-review-action chapter-review-action--done">
          ✓ {t('chapterReview.reviewed')} · {t('chapterReview.openReview')}
        </LocalizedLink>
      </div>
    )
  }
  if (!isReviewableChapter(chapter)) return null
  return (
    <div className="reader-discuss">
      <ReviewChapterButton
        title={bookTitle}
        author={author}
        {...book}
        chapterSlug={chapter.identifier}
        chapterTitle={chapter.title}
        label={`✦ ${t('chapterReview.discussChapter')}`}
      />
    </div>
  )
}
