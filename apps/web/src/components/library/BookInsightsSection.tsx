import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getBookInsights, type BookInsight } from '../../api/insights'
import { useTranslation } from '../../hooks/useTranslation'

/**
 * "What you've worked out" — the conclusions an outside assistant wrote back into
 * this book over MCP.
 *
 * This is the return path, and the reason the write-back is worth having: come
 * back to a book a month later and read the twenty lines that matter instead of
 * the four hundred pages. The server orders them — the book-level overview first,
 * then chapters by number — so this renders the list as it arrives.
 *
 * Renders nothing at all when there is nothing yet. An empty state here would be
 * a tutorial for a feature you can only reach by connecting an assistant, which
 * belongs next to the connect prompt, not on every book page.
 */
interface Props {
  /** Exactly one of these. */
  userBookId?: string
  editionId?: string
}

export function BookInsightsSection({ userBookId, editionId }: Props) {
  const { t } = useTranslation()
  const [insights, setInsights] = useState<BookInsight[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const target = userBookId ? { userBookId } : editionId ? { editionId } : null
    if (!target) return

    let cancelled = false
    setLoading(true)
    getBookInsights(target)
      .then(rows => { if (!cancelled) setInsights(rows) })
      // Silent: this is a supplementary panel and a failure here must never take
      // the book page down with it. Same posture as BookStatsSection.
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userBookId, editionId])

  if (loading || insights.length === 0) return null

  return (
    <section className="book-insights" aria-label={t('library.insights.title')}>
      <h2 className="book-insights__title">{t('library.insights.title')}</h2>
      <p className="book-insights__lead">{t('library.insights.lead')}</p>

      <ol className="book-insights__list">
        {insights.map(insight => (
          <li key={insight.id} className="book-insights__item">
            {/* The TITLE, never the number. `chapterNumber` is what the server
                orders by, but the two book types number differently — a catalog
                page renders `chapterNumber + 1` while an upload renders it
                as-is — so printing it here reads one off from the table of
                contents on exactly one of them. The title identifies the chapter
                to a reader anyway. */}
            <div className="book-insights__scope">
              {insight.chapterSlug === null
                ? t('library.insights.wholeBook')
                // The slug no longer resolves — a re-ingest renamed the chapter.
                // The text is still worth having, so show it unplaced rather than
                // dropping it.
                : insight.chapterTitle ?? insight.chapterSlug}
            </div>

            {insight.question && (
              <div className="book-insights__question">{insight.question}</div>
            )}

            {/* react-markdown does not parse raw HTML (no rehype-raw), so assistant
                output cannot inject markup. No dangerouslySetInnerHTML anywhere. */}
            <div className="book-insights__body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{insight.text}</ReactMarkdown>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
