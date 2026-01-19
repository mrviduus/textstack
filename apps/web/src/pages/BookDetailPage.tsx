import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'
import { useDownload } from '../context/DownloadContext'
import { useLibrary } from '../hooks/useLibrary'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { JsonLd } from '../components/JsonLd'
import { stringToColor } from '../utils/colors'
import { getCachedBookMeta } from '../lib/offlineDb'
import type { BookDetail } from '../types/api'

// Strip HTML tags from description text
function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body.textContent || ''
}

export function BookDetailPage() {
  const { bookSlug } = useParams<{ bookSlug: string }>()
  const api = useApi()
  const { language } = useLanguage()
  const { isDownloading, getProgress, startDownload } = useDownload()
  const { isInLibrary } = useLibrary()
  const [book, setBook] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isOffline, setIsOffline] = useState(false)

  useEffect(() => {
    if (!bookSlug) return
    let cancelled = false
    setLoading(true)
    api.getBook(bookSlug)
      .then((data) => { if (!cancelled) setBook(data) })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bookSlug, api])

  // Check offline status when book loads
  useEffect(() => {
    if (!book?.id) return
    getCachedBookMeta(book.id).then((meta) => {
      if (meta && meta.cachedChapters >= meta.totalChapters) {
        setIsOffline(true)
      } else {
        setIsOffline(false)
      }
    })
  }, [book?.id])

  // Compute available languages for hreflang
  const availableLanguages = useMemo<SupportedLanguage[]>(() => {
    if (!book) return []
    const langs = new Set<SupportedLanguage>([language])
    book.otherEditions.forEach((ed) => {
      if (ed.language === 'uk' || ed.language === 'en') {
        langs.add(ed.language)
      }
    })
    return Array.from(langs)
  }, [book, language])

  if (loading) {
    return (
      <div className="book-detail">
        <div className="book-detail__skeleton" />
      </div>
    )
  }

  if (error || !book) {
    return (
      <div className="book-detail">
        <SeoHead
          title="Book Not Found"
          description="This book doesn't exist or is not available."
          noindex
          statusCode={404}
        />
        <h1>{language === 'uk' ? 'Книгу не знайдено' : 'Book not found'}</h1>
        <p className="error">{error || (language === 'uk' ? 'Не знайдено' : 'Not found')}</p>
        <LocalizedLink to="/" className="back-home-link">
          {language === 'uk' ? 'На головну' : 'Back to Home'}
        </LocalizedLink>
      </div>
    )
  }

  const firstChapter = book.chapters[0]

  return (
    <div className="book-detail">
      <SeoHead
        title={book.title}
        description={book.description || undefined}
        image={book.coverPath ? getStorageUrl(book.coverPath) : undefined}
        type="book"
        availableLanguages={availableLanguages}
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'Book',
          name: book.title,
          description: book.description || undefined,
          inLanguage: book.language,
          image: book.coverPath ? getStorageUrl(book.coverPath) : undefined,
          author: book.authors.map((a) => ({
            '@type': 'Person',
            name: a.name,
            url: `${window.location.origin}/${language}/authors/${a.slug}`,
          })),
          url: window.location.href,
        }}
      />
      <div className="book-detail__header">
        <div
          className="book-detail__cover"
          style={{ backgroundColor: book.coverPath ? undefined : stringToColor(book.title) }}
        >
          {book.coverPath ? (
            <img src={getStorageUrl(book.coverPath)} alt={book.title} title={`${book.title} - Read online free`} />
          ) : (
            <span className="book-detail__cover-text">{book.title?.[0] || '?'}</span>
          )}
        </div>
        <div className="book-detail__info">
          <h1>{book.title}</h1>
          <p className="book-detail__author">
            {book.authors.length > 0
              ? book.authors.map((a, i) => (
                  <span key={a.id}>
                    {i > 0 && ', '}
                    <LocalizedLink to={`/authors/${a.slug}`} className="book-detail__author-link" title={`${a.name} - View biography`}>
                      {a.name}
                    </LocalizedLink>
                  </span>
                ))
              : 'Unknown'}
          </p>
          {book.description && (
            <p className="book-detail__description">{stripHtml(book.description)}</p>
          )}
          <p className="book-detail__meta">
            {book.chapters.length} chapters · {book.language.toUpperCase()}
          </p>
          <div className="book-detail__actions">
            {firstChapter && (
              <LocalizedLink
                to={`/books/${book.slug}/${firstChapter.slug}`}
                className="book-detail__read-btn"
                title={`Start reading ${book.title}`}
              >
                Start Reading
              </LocalizedLink>
            )}
            {book.id && isDownloading(book.id) && (
              <span className="book-detail__download-status book-detail__download-status--downloading">
                Downloading {getProgress(book.id)}%...
              </span>
            )}
            {book.id && !isDownloading(book.id) && isOffline && (
              <span className="book-detail__download-status book-detail__download-status--offline">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Available offline
              </span>
            )}
            {book.id && !isDownloading(book.id) && !isOffline && isInLibrary(book.id) && (
              <button
                className="book-detail__download-btn"
                onClick={() => startDownload(book.id, book.slug, book.title, language)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download for offline
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="book-detail__toc">
        <h2>Chapters</h2>
        <ul>
          {book.chapters.map((ch) => (
            <li key={ch.id}>
              <LocalizedLink to={`/books/${book.slug}/${ch.slug}`} title={`Read ${ch.title}`}>
                <span className="chapter-number">{ch.chapterNumber + 1}.</span>
                <span className="chapter-title">{ch.title}</span>
                {ch.wordCount && (
                  <span className="chapter-words">{ch.wordCount} words</span>
                )}
              </LocalizedLink>
            </li>
          ))}
        </ul>
      </div>

      {book.otherEditions.length > 0 && (
        <div className="book-detail__editions">
          <h2>Other Editions</h2>
          <ul>
            {book.otherEditions.map((ed) => (
              <li key={ed.slug}>
                <Link to={`/${ed.language}/books/${ed.slug}`} title={`Read ${ed.title} in ${ed.language.toUpperCase()}`}>
                  {ed.title} ({ed.language.toUpperCase()})
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <LocalizedLink to="/books" className="book-detail__back" title="Browse all books">
        Back to Books
      </LocalizedLink>
    </div>
  )
}
