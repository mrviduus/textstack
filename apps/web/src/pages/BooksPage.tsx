import { useState, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import { stringToColor } from '../utils/colors'
import type { Edition } from '../types/api'

const BOOKS_PER_PAGE = 12

export function BooksPage() {
  const { t } = useTranslation()
  const api = useApi()
  const [books, setBooks] = useState<Edition[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    api.getBooks({
      limit: BOOKS_PER_PAGE,
      offset: (page - 1) * BOOKS_PER_PAGE
    })
      .then((data) => {
        setBooks(data.items ?? [])
        setTotal(data.total)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [api, page])

  const totalPages = Math.ceil(total / BOOKS_PER_PAGE)

  if (loading) {
    return (
      <div className="books-page">
        <h1>{t('books.title')}</h1>
        <div className="books-grid">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="book-card book-card--skeleton">
              <div className="book-card__cover" />
              <div className="book-card__title" />
              <div className="book-card__author" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="books-page">
        <h1>{t('books.title')}</h1>
        <p className="error">Error: {error}</p>
      </div>
    )
  }

  return (
    <>
    <div className="books-page">
      <SeoHead title={t('books.title')} description={t('books.seoDesc')} />
      <h1>{t('books.title')}</h1>
      {books.length === 0 ? (
        <p>{t('books.noBooksYet')}</p>
      ) : (
        <>
          <div className="books-grid">
            {books.map((book) => (
              <LocalizedLink key={book.id} to={`/books/${book.slug}`} className="book-card" title={t('books.readOnline').replace('{title}', book.title)}>
                <div
                  className="book-card__cover"
                  style={{ backgroundColor: book.coverPath ? undefined : stringToColor(book.title) }}
                >
                  {book.coverPath ? (
                    <img src={getStorageUrl(book.coverPath)} alt={book.title} title={t('books.readOnlineFree').replace('{title}', book.title)} />
                  ) : (
                    <span className="book-card__cover-text">{book.title?.[0] || '?'}</span>
                  )}
                </div>
                <h3 className="book-card__title">{book.title}</h3>
                <p className="book-card__author">
                  {book.authors.length > 0
                    ? book.authors.map(a => a.name).join(', ')
                    : t('books.unknown')}
                </p>
                <p className="book-card__meta">{book.chapterCount} {t('books.chapters')}</p>
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
                {t('books.previous')}
              </button>
              <span className="search-page__pagination-info">
                {t('books.page').replace('{page}', String(page)).replace('{total}', String(totalPages))}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="search-page__pagination-btn"
              >
                {t('books.next')}
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
