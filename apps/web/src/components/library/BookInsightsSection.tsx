import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { insightChapterLabel, insightDateLabel, type BookInsight } from '@textstack/shared'
import { getBookInsights, deleteBookInsight } from '../../api/insights'
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
  // The id being removed, so the row can say so and cannot be double-submitted.
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    const target = userBookId ? { userBookId } : editionId ? { editionId } : null
    if (!target) return

    let cancelled = false
    setLoading(true)
    getBookInsights(target)
      .then(rows => { if (!cancelled) setInsights(rows) })
      // Silent: this is a supplementary panel and a failure here must never take the book page
      // down with it. Same posture as BookStatsSection.
      //
      // That posture is also how this section stayed invisible on the web for its whole life: it
      // used to call the SHARED insights client, which routes through an api layer only the mobile
      // app initialises, so every call rejected before reaching the network and this catch ate it.
      // Silence is right for a network failure and wrong for a wiring mistake, and it cannot tell
      // them apart — hence the web-local client above, whose auth actually works here.
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userBookId, editionId])

  // Removed here as well as on the server: the section disappears when the last one goes, and a
  // list that still shows a row the server no longer has is worse than a slow one.
  const remove = async (id: string) => {
    setRemoving(id)
    try {
      await deleteBookInsight(id)
      setInsights(prev => prev.filter(i => i.id !== id))
    } catch {
      // Same posture as the load: a supplementary panel never takes the book page down. The row
      // stays, which is the honest outcome — it is still there.
    } finally {
      setRemoving(null)
    }
  }

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
              {/* A conclusion filed against the wrong chapter is never revisited by the assistant —
                  it only ever replaces its own row for the chapter it MEANT. Removing it is the
                  reader's, and only the reader's. Its own element, not inside the label: the label
                  is what says which chapter this is, and it should read as only that. */}
              <button
                type="button"
                className="book-insights__remove"
                onClick={() => remove(insight.id)}
                disabled={removing === insight.id}
                aria-label={t('library.insights.remove')}
                title={t('library.insights.remove')}
              >
                ×
              </button>
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
