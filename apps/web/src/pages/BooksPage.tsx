import { useState, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { useLanguage } from '../context/LanguageContext'
import { stringToColor } from '../utils/colors'
import type { Edition } from '../types/api'

const BOOKS_PER_PAGE = 12

export function BooksPage() {
  const { language } = useLanguage()
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
        <h1>Books</h1>
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
        <h1>Books</h1>
        <p className="error">Error: {error}</p>
      </div>
    )
  }

  const title = language === 'uk' ? 'Книги' : 'Books'
  const description = language === 'uk'
    ? 'Читайте книги онлайн безкоштовно | TextStack'
    : 'Read books online for free | TextStack'

  return (
    <div className="books-page">
      <SeoHead title={title} description={description} />
      <h1>{title}</h1>
      {books.length === 0 ? (
        <p>No books available yet.</p>
      ) : (
        <>
          <div className="books-grid">
            {books.map((book) => (
              <LocalizedLink key={book.id} to={`/books/${book.slug}`} className="book-card" title={`Read ${book.title} online`}>
                <div
                  className="book-card__cover"
                  style={{ backgroundColor: book.coverPath ? undefined : stringToColor(book.title) }}
                >
                  {book.coverPath ? (
                    <img src={getStorageUrl(book.coverPath)} alt={book.title} title={`${book.title} - Read online free`} />
                  ) : (
                    <span className="book-card__cover-text">{book.title?.[0] || '?'}</span>
                  )}
                </div>
                <h3 className="book-card__title">{book.title}</h3>
                <p className="book-card__author">
                  {book.authors.length > 0
                    ? book.authors.map(a => a.name).join(', ')
                    : 'Unknown'}
                </p>
                <p className="book-card__meta">{book.chapterCount} chapters</p>
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
  )
}
