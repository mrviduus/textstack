import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { insightChapterLabel, insightDateLabel, type BookInsight } from '@textstack/shared'
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
  /** From the page's `useBookReviews`. */
  insights: BookInsight[]
}

export function BookInsightsSection({ insights }: Props) {
  const { t } = useTranslation()
  if (insights.length === 0) return null

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
            <div className="book-insights__head">
              <div className="book-insights__scope">
                {insightChapterLabel(insight) ?? t('library.insights.wholeBook')}
              </div>
              {/* When it was last written. A конспект is read months later, and without a date it
                  cannot answer "is this what I thought then, or what I think now". */}
              {insightDateLabel(insight) && (
                <time className="book-insights__date" dateTime={insight.updatedAt}>
                  {insightDateLabel(insight)}
                </time>
              )}
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
