import { useState, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { getStorageUrl } from '../api/client'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useLanguage } from '../context/LanguageContext'
import type { Author } from '../types/api'

export function AuthorsPage() {
  const { language } = useLanguage()
  const api = useApi()
  const [authors, setAuthors] = useState<Author[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getAuthors()
      .then((data) => setAuthors(data.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [api])

  const title = language === 'uk' ? 'Автори' : 'Authors'
  const description = language === 'uk'
    ? 'Перегляньте список авторів | TextStack'
    : 'Browse our list of authors | TextStack'

  if (loading) {
    return (
      <div className="authors-page">
        <SeoHead title={title} description={description} />
        <h1>{title}</h1>
        <div className="authors-grid">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="author-card author-card--skeleton">
              <div className="author-card__photo" />
              <div className="author-card__name" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="authors-page">
        <SeoHead title={title} description={description} />
        <h1>{title}</h1>
        <p className="error">Error: {error}</p>
      </div>
    )
  }

  return (
    <>
    <div className="authors-page">
      <SeoHead title={title} description={description} />
      <h1>{title}</h1>
      {authors.length === 0 ? (
        <p>{language === 'uk' ? 'Авторів поки немає.' : 'No authors available yet.'}</p>
      ) : (
        <div className="authors-grid">
          {authors.map((author) => (
            <LocalizedLink key={author.id} to={`/authors/${author.slug}`} className="author-card" title={`${author.name} - View biography`}>
              <div className="author-card__photo">
                {author.photoPath ? (
                  <img src={getStorageUrl(author.photoPath)} alt={author.name} title={`${author.name} - Biography and books`} />
                ) : (
                  <span className="author-card__initials">{author.name?.[0] || '?'}</span>
                )}
              </div>
              <h3 className="author-card__name">{author.name}</h3>
              <p className="author-card__count">
                {author.bookCount} {language === 'uk' ? 'книг' : 'books'}
              </p>
            </LocalizedLink>
          ))}
        </div>
      )}
    </div>
    <Footer />
    </>
  )
}
