import { useState, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { useLanguage } from '../context/LanguageContext'
import type { Genre } from '../types/api'

export function GenresPage() {
  const { language } = useLanguage()
  const api = useApi()
  const [genres, setGenres] = useState<Genre[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getGenres()
      .then((data) => setGenres(data.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [api])

  const title = language === 'uk' ? 'Жанри' : 'Genres'
  const description = language === 'uk'
    ? 'Перегляньте книги за жанрами | TextStack'
    : 'Browse books by genre | TextStack'

  if (loading) {
    return (
      <div className="genres-page">
        <SeoHead title={title} description={description} />
        <h1>{title}</h1>
        <div className="genres-grid">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="genre-card genre-card--skeleton">
              <div className="genre-card__name" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="genres-page">
        <SeoHead title={title} description={description} />
        <h1>{title}</h1>
        <p className="error">Error: {error}</p>
      </div>
    )
  }

  return (
    <div className="genres-page">
      <SeoHead title={title} description={description} />
      <h1>{title}</h1>
      {genres.length === 0 ? (
        <p>{language === 'uk' ? 'Жанрів поки немає.' : 'No genres available yet.'}</p>
      ) : (
        <div className="genres-grid">
          {genres.map((genre) => (
            <LocalizedLink key={genre.id} to={`/genres/${genre.slug}`} className="genre-card" title={`${genre.name} books`}>
              <h3 className="genre-card__name">{genre.name}</h3>
              <p className="genre-card__count">
                {genre.bookCount} {language === 'uk' ? 'книг' : 'books'}
              </p>
              {genre.description && (
                <p className="genre-card__description">{genre.description}</p>
              )}
            </LocalizedLink>
          ))}
        </div>
      )}
    </div>
  )
}
