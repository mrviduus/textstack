import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { useTranslation } from '../hooks/useTranslation'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import type { SearchResult } from '../types/api'

const RESULTS_PER_PAGE = 20

export function SearchPage() {
  const [searchParams] = useSearchParams()
  const query = searchParams.get('q') || ''
  const api = useApi()
  const { t } = useTranslation()

  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([])
      setTotal(0)
      return
    }

    setLoading(true)
    setError(null)

    api.search(query, {
      limit: RESULTS_PER_PAGE,
      offset: (page - 1) * RESULTS_PER_PAGE,
      highlight: true
    })
      .then((data) => {
        setResults(data.items)
        setTotal(data.total)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [api, query, page])

  // Reset page when query changes
  useEffect(() => {
    setPage(1)
  }, [query])

  const totalPages = Math.ceil(total / RESULTS_PER_PAGE)

  const renderHighlight = (html: string) => {
    return <span dangerouslySetInnerHTML={{ __html: html }} />
  }

  if (!query) {
    return (
      <>
      <div className="search-page">
        <SeoHead title={t('search.title')} noindex />
        <h1>{t('search.title')}</h1>
        <p className="search-page__empty">
          {t('search.enterQuery')}
        </p>
      </div>
      <Footer />
      </>
    )
  }

  return (
    <>
    <div className="search-page">
      <SeoHead title={`${t('search.title')}: ${query}`} noindex />
      <h1>{t('search.title')}: "{query}"</h1>

      {loading ? (
        <div className="search-page__results">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="search-page__result search-page__result--skeleton">
              <div className="search-page__result-cover" />
              <div className="search-page__result-info">
                <div className="search-page__result-title" />
                <div className="search-page__result-author" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="error">Error: {error}</p>
      ) : results.length === 0 ? (
        <p className="search-page__empty">
          {t('search.noResults')}
        </p>
      ) : (
        <>
          <p className="search-page__count">
            {t('search.foundResults').replace('{total}', String(total))}
          </p>

          <div className="search-page__results">
            {results.map((result) => (
              <LocalizedLink
                key={result.chapterId}
                to={`/books/${result.edition.slug}`}
                className="search-page__result"
                title={t('search.readOnline').replace('{title}', result.edition.title)}
              >
                <div
                  className="search-page__result-cover"
                  style={{ backgroundColor: result.edition.coverPath ? undefined : '#e0e0e0' }}
                >
                  {result.edition.coverPath ? (
                    <img src={getStorageUrl(result.edition.coverPath)} alt={result.edition.title} title={t('search.readOnlineFree').replace('{title}', result.edition.title)} />
                  ) : (
                    <span>{result.edition.title?.[0] || '?'}</span>
                  )}
                </div>
                <div className="search-page__result-info">
                  <h3 className="search-page__result-title">{result.edition.title}</h3>
                  <p className="search-page__result-chapter">
                    {result.chapterTitle || `${t('search.chapter')} ${result.chapterNumber}`}
                  </p>
                  {result.edition.authors && (
                    <p className="search-page__result-author">
                      {result.edition.authors}
                    </p>
                  )}
                  {result.highlights && result.highlights.length > 0 && (
                    <div className="search-page__result-highlights">
                      {result.highlights.slice(0, 2).map((highlight, i) => (
                        <p key={i} className="search-page__result-highlight">
                          {renderHighlight(highlight)}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </LocalizedLink>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="search-page__pagination">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="search-page__pagination-btn"
              >
                {t('search.previous')}
              </button>
              <span className="search-page__pagination-info">
                {t('search.page').replace('{page}', String(page)).replace('{total}', String(totalPages))}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="search-page__pagination-btn"
              >
                {t('search.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
    <Footer />
    </>
  )
}
