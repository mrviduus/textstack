import { useState, useEffect } from 'react'
import { useTranslation } from '../../hooks/useTranslation'
import { useApi } from '../../hooks/useApi'
import { getStorageUrl } from '../../api/client'
import { LocalizedLink } from '../LocalizedLink'
import type { Edition } from '../../types/api'

const BOOK_LIMIT = 12

export function RecentBooksSection() {
  const { t } = useTranslation()
  const api = useApi()
  const [books, setBooks] = useState<Edition[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getBooks({ limit: BOOK_LIMIT })
      .then((data) => setBooks(data.items))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [api])

  if (loading) {
    return (
      <section className="home-books">
        <h2 className="home-books__title">{t('home.recentBooks.title')}</h2>
        <div className="home-books__grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="home-book-card home-book-card--skeleton">
              <div className="home-book-card__cover" />
              <div className="home-book-card__info" />
            </div>
          ))}
        </div>
      </section>
    )
  }

  if (books.length === 0) {
    return (
      <section className="home-books">
        <h2 className="home-books__title">{t('home.recentBooks.title')}</h2>
        <p className="home-books__empty">{t('common.noBooksYet')}</p>
      </section>
    )
  }

  return (
    <section className="home-books">
      <h2 className="home-books__title">{t('home.recentBooks.title')}</h2>
      <div className="home-books__grid">
        {books.map((book) => (
          <LocalizedLink key={book.id} to={`/books/${book.slug}`} className="home-book-card" title={`Read ${book.title} online`}>
            <div className="home-book-card__cover">
              {book.coverPath ? (
                <img src={getStorageUrl(book.coverPath)} alt={book.title} title={`${book.title} - Read online free`} />
              ) : (
                <span className="home-book-card__no-cover">{book.title[0]}</span>
              )}
            </div>
            <div className="home-book-card__info">
              <h3 className="home-book-card__title">{book.title}</h3>
              {book.authors.length > 0 && (
                <p className="home-book-card__author">{book.authors.map(a => a.name).join(', ')}</p>
              )}
            </div>
          </LocalizedLink>
        ))}
      </div>
      <LocalizedLink to="/books" className="home-books__view-all" title="Browse all books">
        {t('home.recentBooks.viewAll')}
      </LocalizedLink>
    </section>
  )
}
