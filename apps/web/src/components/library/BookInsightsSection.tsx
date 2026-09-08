import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { insightsApi, insightChapterLabel, type BookInsight } from '@textstack/shared'
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
    insightsApi.getBookInsights(target)
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
            {/* Which chapter, decided once in the shared package — never the
                number, and falling back to the slug when a re-ingest left the
                title unresolvable. See insightScope.ts for why both matter. */}
            <div className="book-insights__scope">
              {insightChapterLabel(insight) ?? t('library.insights.wholeBook')}
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
