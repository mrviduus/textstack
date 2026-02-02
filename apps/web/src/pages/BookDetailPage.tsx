import { useState, useEffect, useMemo } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'
import { useDownload } from '../context/DownloadContext'
import { useLibrary } from '../hooks/useLibrary'
import { useSite } from '../context/SiteContext'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { JsonLd } from '../components/JsonLd'
import { stringToColor } from '../utils/colors'
import { getCachedBookMeta } from '../lib/offlineDb'
import { getCanonicalOrigin, buildCanonicalUrl } from '../lib/canonicalUrl'
import {
  getThemes,
  getFAQs,
  generateAboutText,
  generateRelevanceText,
  generateThemeDescription,
} from '../lib/bookSeo'
import type { BookDetail } from '../types/api'

// Strip HTML tags from description text
function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body.textContent || ''
}

// Format chapter number with leading zero
function formatChapterNumber(num: number): string {
  return String(num + 1).padStart(2, '0')
}

export function BookDetailPage() {
  const { bookSlug } = useParams<{ bookSlug: string }>()
  const location = useLocation()
  const api = useApi()
  const { language } = useLanguage()
  const { isDownloading, getProgress, startDownload } = useDownload()
  const { isInLibrary } = useLibrary()
  const { site } = useSite()
  const canonicalOrigin = getCanonicalOrigin(site?.primaryDomain)
  const [book, setBook] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isOffline, setIsOffline] = useState(false)
  const [showAllChapters, setShowAllChapters] = useState(false)

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
      <div className="book-detail--stitch">
        <div className="book-detail__skeleton" />
      </div>
    )
  }

  if (error || !book) {
    return (
      <div className="book-detail--stitch">
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
  const visibleChapters = showAllChapters ? book.chapters : book.chapters.slice(0, 5)
  const hasMoreChapters = book.chapters.length > 5

  return (
    <div className="book-detail--stitch">
      <SeoHead
        title={book.seoTitle || book.title}
        description={book.seoDescription || book.description || undefined}
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
          image: book.coverPath ? (() => {
            const url = getStorageUrl(book.coverPath)
            return url?.startsWith('http') ? url : `${canonicalOrigin}${url}`
          })() : undefined,
          author: book.authors.map((a) => ({
            '@type': 'Person',
            name: a.name,
            url: buildCanonicalUrl({ origin: canonicalOrigin, pathname: `/${language}/authors/${a.slug}` }),
          })),
          url: buildCanonicalUrl({ origin: canonicalOrigin, pathname: location.pathname }),
        }}
      />

      {/* Hero Section */}
      <section className="book-hero">
        {/* Cover */}
        <div className="book-hero__cover-wrapper">
          <div
            className="book-hero__cover"
            style={{ backgroundColor: book.coverPath ? undefined : stringToColor(book.title) }}
          >
            {book.coverPath ? (
              <img src={getStorageUrl(book.coverPath)} alt={book.title} title={`${book.title} - Read online free`} />
            ) : (
              <span className="book-hero__cover-text">{book.title?.[0] || '?'}</span>
            )}
          </div>
          <div className="book-hero__cover-border" />
        </div>

        {/* Info */}
        <div className="book-hero__info">
          <h1 className="book-hero__title">{book.title}</h1>

          <p className="book-hero__author">
            {book.authors.length > 0
              ? book.authors.map((a, i) => (
                  <span key={a.id}>
                    {i > 0 && ', '}
                    <LocalizedLink to={`/authors/${a.slug}`} className="book-hero__author-link" title={`${a.name} - View biography`}>
                      {a.name}
                    </LocalizedLink>
                  </span>
                ))
              : 'Unknown'}
          </p>

          {book.description && (
            <div className="book-hero__description">
              <p>{stripHtml(book.description)}</p>
            </div>
          )}

          <div className="book-hero__meta">
            <span className="book-hero__meta-item">
              <span className="material-icons-outlined">auto_stories</span>
              {book.chapters.length} {language === 'uk' ? 'розділів' : 'chapters'}
            </span>
            <span className="book-hero__meta-dot" />
            <span className="book-hero__meta-item book-hero__meta-item--lang">
              {book.language.toUpperCase()}
            </span>
          </div>

          <div className="book-hero__actions">
            {firstChapter && (
              <LocalizedLink
                to={`/books/${book.slug}/${firstChapter.slug}?direct=1`}
                className="book-hero__read-btn"
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
      </section>

      {/* Chapters Section */}
      <section className="book-chapters">
        <h2 className="book-chapters__heading">
          Chapters
          <span className="book-chapters__heading-line" />
        </h2>

        <div className="book-chapters__list">
          {visibleChapters.map((ch) => (
            <LocalizedLink
              key={ch.id}
              to={`/books/${book.slug}/${ch.slug}?direct=1`}
              className="book-chapters__item"
              title={`Read ${ch.title}`}
            >
              <div className="book-chapters__item-left">
                <span className="book-chapters__number">{formatChapterNumber(ch.chapterNumber)}.</span>
                <h3 className="book-chapters__title">{ch.title}</h3>
              </div>
              <div className="book-chapters__item-right">
                {ch.wordCount && (
                  <span className="book-chapters__words">{ch.wordCount} words</span>
                )}
                <span className="book-chapters__arrow material-icons-outlined">arrow_forward_ios</span>
              </div>
            </LocalizedLink>
          ))}
        </div>

        {hasMoreChapters && !showAllChapters && (
          <button
            className="book-chapters__view-all"
            onClick={() => setShowAllChapters(true)}
          >
            View all {book.chapters.length} chapters
            <span className="material-icons-outlined">expand_more</span>
          </button>
        )}
      </section>

      {/* What is it about */}
      <section className="book-about">
        <h2>What is {book.title} about?</h2>
        <p>{generateAboutText(book)}</p>
      </section>

      {/* Themes */}
      {getThemes(book).length > 0 && (
        <section className="book-themes">
          <h2>Main themes in {book.title}</h2>
          <div className="book-themes__grid">
            {getThemes(book).map((theme) => (
              <div key={theme} className="book-themes__item">
                <h3>{theme}</h3>
                <p>{generateThemeDescription(theme, book.title)}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Relevance */}
      <section className="book-relevance">
        <h2>Why {book.title} is still relevant today</h2>
        <p>{generateRelevanceText(book)}</p>
      </section>

      {/* Author */}
      {book.authors.length > 0 && (
        <section className="book-author-section">
          <h2>About the author</h2>
          <LocalizedLink to={`/authors/${book.authors[0].slug}`}>
            {book.authors[0].name}
          </LocalizedLink>
        </section>
      )}

      {/* FAQ */}
      <section className="book-faq">
        <h2>Frequently Asked Questions</h2>
        {getFAQs(book).map((faq, i) => (
          <details key={i}>
            <summary>{faq.question}</summary>
            <p>{faq.answer}</p>
          </details>
        ))}
      </section>

      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: getFAQs(book).map((faq) => ({
            '@type': 'Question',
            name: faq.question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: faq.answer,
            },
          })),
        }}
      />

      {/* Other Editions */}
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
