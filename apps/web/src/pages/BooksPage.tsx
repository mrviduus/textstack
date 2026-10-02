import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useDebounce } from '../hooks/useDebounce'
import { getStorageUrl } from '../api/client'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { JsonLd } from '../components/JsonLd'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import { useLanguage } from '../context/LanguageContext'
import { useSite } from '../context/SiteContext'
import { stringToColor } from '../utils/colors'
import { getCanonicalOrigin } from '../lib/canonicalUrl'
import { buildItemListSchema } from '../lib/itemListSchema'
import type { Edition, Genre } from '../types/api'

const BOOKS_PER_PAGE = 12

export function BooksPage() {
  const { t } = useTranslation()
  const { language } = useLanguage()
  const { site } = useSite()
  const api = useApi()
  const [searchParams, setSearchParams] = useSearchParams()

  const q = searchParams.get('q') || ''
  const genre = searchParams.get('genre') || ''
  const sort = searchParams.get('sort') || ''
  const pageParam = parseInt(searchParams.get('page') || '1', 10)
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam

  const [searchInput, setSearchInput] = useState(q)
  const debouncedSearch = useDebounce(searchInput, 300)

  const [books, setBooks] = useState<Edition[]>([])
  const [total, setTotal] = useState(0)
  const [genres, setGenres] = useState<Genre[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch genres for current language
  useEffect(() => {
    api.getGenres({ language }).then(data => setGenres(data.items)).catch(() => {})
  }, [api, language])

  // Update URL when debounced search changes
  useEffect(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (debouncedSearch) next.set('q', debouncedSearch)
      else next.delete('q')
      next.set('page', '1')
      return next
    }, { replace: true })
  }, [debouncedSearch]) // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = useCallback((key: string, value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      next.set('page', '1')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setPage = useCallback((p: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('page', String(p))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const clearFilters = useCallback(() => {
    setSearchInput('')
    setSearchParams({}, { replace: true })
  }, [setSearchParams])

  // Fetch books
  useEffect(() => {
    setLoading(true)
    api.getBooks({
      limit: BOOKS_PER_PAGE,
      offset: (page - 1) * BOOKS_PER_PAGE,
      search: q || undefined,
      genre: genre || undefined,
      sort: sort || undefined,
    })
      .then((data) => {
        setBooks(data.items ?? [])
        setTotal(data.total)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [api, page, q, genre, sort])

  const totalPages = Math.ceil(total / BOOKS_PER_PAGE)
  const hasFilters = !!(q || genre || sort)
  // Only emit ItemList on the canonical indexable version of this page,
  // otherwise crawlers would ingest structured duplicates for every filter combo.
  const isIndexable = page === 1 && !hasFilters
  const canonicalOrigin = getCanonicalOrigin(site?.primaryDomain)

  return (
    <>
    <div className="books-page">
      {/*
        Noindex filtered / paginated catalogue views to prevent:
          - duplicate meta (every page?2..N shares the same title/description)
          - thin or near-duplicate result pages
          - infinite URL permutations from ?q= / ?genre= / ?sort= combinations
        Page 1 with no filters remains indexable as the canonical list.
      */}
      <SeoHead
        title={t('books.title')}
        description={t('books.seoDesc')}
        noindex={page > 1 || hasFilters}
      />
      {isIndexable && books.length > 0 && (
        <JsonLd
          data={buildItemListSchema({
            origin: canonicalOrigin,
            name: t('books.title'),
            description: t('books.seoDesc'),
            items: books.map((b) => ({
              url: `/${language}/books/${b.slug}`,
              name: b.title,
              image: b.coverPath ? getStorageUrl(b.coverPath) : null,
            })),
          })}
        />
      )}
      <h1>{t('books.title')}</h1>

      {/* Filters */}
      <div className="catalogue-filters">
        <div className="catalogue-filters__search">
          <svg className="catalogue-filters__search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            className="catalogue-filters__input"
            placeholder={t('books.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <select
          className="catalogue-filters__sort"
          value={sort === 'popular' ? '' : sort}
          onChange={(e) => setFilter('sort', e.target.value)}
        >
          <option value="">{t('books.sortPopular')}</option>
          <option value="recent">{t('books.sortRecent')}</option>
          <option value="title">{t('books.sortTitle')}</option>
          <option value="oldest">{t('books.sortOldest')}</option>
        </select>
      </div>

      {/* Genre chips */}
      {genres.length > 0 && (
        <div className="catalogue-genres">
          <button
            className={`catalogue-genres__chip ${!genre ? 'catalogue-genres__chip--active' : ''}`}
            onClick={() => setFilter('genre', '')}
          >
            {t('books.allCategories')}
          </button>
          {genres.map((g) => (
            <LocalizedLink
              key={g.id}
              to={`/genres/${g.slug}`}
              className={`catalogue-genres__chip ${genre === g.slug ? 'catalogue-genres__chip--active' : ''}`}
              onClick={(e: React.MouseEvent) => { e.preventDefault(); setFilter('genre', genre === g.slug ? '' : g.slug) }}
            >
              {g.name}
            </LocalizedLink>
          ))}
        </div>
      )}

      {loading ? (
        <div className="books-grid">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="book-card book-card--skeleton">
              <div className="book-card__cover" />
              <div className="book-card__title" />
              <div className="book-card__author" />
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="error">Error: {error}</p>
      ) : books.length === 0 ? (
        <div className="catalogue-empty">
          <p>{hasFilters ? t('books.noResults') : t('books.noBooksYet')}</p>
          {hasFilters && (
            <button className="catalogue-empty__clear" onClick={clearFilters}>
              {t('books.clearFilters')}
            </button>
          )}
        </div>
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
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="search-page__pagination-btn"
              >
                {t('books.previous')}
              </button>
              <span className="search-page__pagination-info">
                {t('books.page').replace('{page}', String(page)).replace('{total}', String(totalPages))}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
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
