import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { JsonLd } from '../components/JsonLd'
import { useLanguage } from '../context/LanguageContext'
import type { AuthorDetail } from '../types/api'

export function AuthorDetailPage() {
  const { slug } = useParams<{ slug: string }>()
  const { language } = useLanguage()
  const api = useApi()
  const [author, setAuthor] = useState<AuthorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    api.getAuthor(slug)
      .then((data) => { if (!cancelled) setAuthor(data) })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [api, slug])

  if (loading) {
    return (
      <div className="author-detail">
        <div className="author-detail__header author-detail__header--skeleton">
          <div className="author-detail__photo" />
          <div className="author-detail__info">
            <div className="author-detail__name" />
            <div className="author-detail__bio" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !author) {
    return (
      <div className="author-detail">
        <SeoHead
          title="Author Not Found"
          description="This author doesn't exist or has no published books."
          noindex
          statusCode={404}
        />
        <h1>{language === 'uk' ? 'Автор не знайдений' : 'Author not found'}</h1>
        <p className="error">{error || 'Not found'}</p>
      </div>
    )
  }

  const seoTitle = language === 'uk'
    ? `${author.name} — книги автора`
    : `${author.name} — books by author`
  const seoDescription = author.bio || (language === 'uk'
    ? `Читайте книги автора ${author.name} онлайн`
    : `Read books by ${author.name} online`)

  return (
    <div className="author-detail">
      <SeoHead
        title={seoTitle}
        description={seoDescription}
        image={author.photoPath ? getStorageUrl(author.photoPath) : undefined}
        type="profile"
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'Person',
          name: author.name,
          description: author.bio || undefined,
          image: author.photoPath ? getStorageUrl(author.photoPath) : undefined,
          url: window.location.href,
        }}
      />

      <div className="author-detail__header">
        <div className="author-detail__photo">
          {author.photoPath ? (
            <img src={getStorageUrl(author.photoPath)} alt={author.name} title={`${author.name} - Biography and books`} />
          ) : (
            <span className="author-detail__initials">{author.name?.[0] || '?'}</span>
          )}
        </div>
        <div className="author-detail__info">
          <h1 className="author-detail__name">{author.name}</h1>
          {author.bio && <p className="author-detail__bio">{author.bio}</p>}
          <p className="author-detail__count">
            {author.editions.length} {language === 'uk' ? 'книг' : 'books'}
          </p>
        </div>
      </div>

      <h2>{language === 'uk' ? 'Книги' : 'Books'}</h2>
      {author.editions.length === 0 ? (
        <p>{language === 'uk' ? 'Книг поки немає.' : 'No books available.'}</p>
      ) : (
        <div className="books-grid">
          {author.editions.map((book) => (
            <LocalizedLink key={book.id} to={`/books/${book.slug}`} className="book-card" title={`Read ${book.title} online`}>
              <div className="book-card__cover" style={{ backgroundColor: book.coverPath ? undefined : '#e0e0e0' }}>
                {book.coverPath ? (
                  <img src={getStorageUrl(book.coverPath)} alt={book.title} title={`${book.title} - Read online free`} />
                ) : (
                  <span className="book-card__cover-text">{book.title?.[0] || '?'}</span>
                )}
              </div>
              <h3 className="book-card__title">{book.title}</h3>
            </LocalizedLink>
          ))}
        </div>
      )}
    </div>
  )
}
