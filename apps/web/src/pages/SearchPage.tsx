import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { useLanguage } from '../context/LanguageContext'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import type { SearchResult } from '../types/api'

const RESULTS_PER_PAGE = 20

export function SearchPage() {
  const [searchParams] = useSearchParams()
  const query = searchParams.get('q') || ''
  const api = useApi()
  const { language } = useLanguage()

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

  const title = language === 'uk' ? 'Пошук' : 'Search'

  if (!query) {
    return (
      <>
      <div className="search-page">
        <SeoHead title={title} noindex />
        <h1>{title}</h1>
        <p className="search-page__empty">
          {language === 'uk' ? 'Введіть запит для пошуку' : 'Enter a search query'}
        </p>
      </div>
      <Footer />
      </>
    )
  }

  return (
    <>
    <div className="search-page">
      <SeoHead title={`${title}: ${query}`} noindex />
      <h1>{title}: "{query}"</h1>

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
          {language === 'uk' ? 'Нічого не знайдено' : 'No results found'}
        </p>
      ) : (
        <>
          <p className="search-page__count">
            {language === 'uk'
              ? `Знайдено ${total} результатів`
              : `Found ${total} results`}
          </p>

          <div className="search-page__results">
            {results.map((result) => (
              <LocalizedLink
                key={result.chapterId}
                to={`/books/${result.edition.slug}`}
                className="search-page__result"
                title={`Read ${result.edition.title} online`}
              >
                <div
                  className="search-page__result-cover"
                  style={{ backgroundColor: result.edition.coverPath ? undefined : '#e0e0e0' }}
                >
                  {result.edition.coverPath ? (
                    <img src={getStorageUrl(result.edition.coverPath)} alt={result.edition.title} title={`${result.edition.title} - Read online free`} />
                  ) : (
                    <span>{result.edition.title?.[0] || '?'}</span>
                  )}
                </div>
                <div className="search-page__result-info">
                  <h3 className="search-page__result-title">{result.edition.title}</h3>
                  <p className="search-page__result-chapter">
                    {result.chapterTitle || `Chapter ${result.chapterNumber}`}
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
                {language === 'uk' ? '← Назад' : '← Previous'}
              </button>
              <span className="search-page__pagination-info">
                {language === 'uk'
                  ? `Сторінка ${page} з ${totalPages}`
                  : `Page ${page} of ${totalPages}`}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="search-page__pagination-btn"
              >
                {language === 'uk' ? 'Далі →' : 'Next →'}
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
