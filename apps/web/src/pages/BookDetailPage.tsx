import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'
import { useAuth } from '../context/AuthContext'
import { useLibrary } from '../hooks/useLibrary'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { JsonLd } from '../components/JsonLd'
import { stringToColor } from '../utils/colors'
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
  const { isAuthenticated } = useAuth()
  const { toggle: toggleLibrary, isInLibrary } = useLibrary()
  const [book, setBook] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [libraryLoading, setLibraryLoading] = useState(false)

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
        <h1>Error</h1>
        <p>{error || 'Book not found'}</p>
        <LocalizedLink to="/books" title="Browse all books">Back to Books</LocalizedLink>
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
            {isAuthenticated && (
              <button
                className={`book-detail__library-btn ${isInLibrary(book.id) ? 'in-library' : ''}`}
                onClick={async () => {
                  setLibraryLoading(true)
                  try {
                    await toggleLibrary(book.id)
                  } finally {
                    setLibraryLoading(false)
                  }
                }}
                disabled={libraryLoading}
              >
                {libraryLoading ? '...' : isInLibrary(book.id) ? 'In Library' : 'Add to Library'}
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
