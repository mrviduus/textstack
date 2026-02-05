import { useState, useEffect } from 'react'
import { useTranslation } from '../../hooks/useTranslation'
import { useApi } from '../../hooks/useApi'
import { getStorageUrl } from '../../api/client'
import { LocalizedLink } from '../LocalizedLink'
import { HttpError } from '../../lib/fetchWithRetry'
import type { Author } from '../../types/api'

const AUTHOR_LIMIT = 8

export function RecentAuthorsSection() {
  const { t } = useTranslation()
  const api = useApi()
  const [authors, setAuthors] = useState<Author[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getAuthors({ limit: AUTHOR_LIMIT, sort: 'recent' })
      .then((data) => setAuthors(data.items))
      .catch((err) => {
        console.error('Failed to load authors:', err)
        if (err instanceof HttpError) {
          setError(`Error ${err.status}`)
        } else {
          setError('Connection error')
        }
      })
      .finally(() => setLoading(false))
  }, [api])

  if (loading) {
    return (
      <section className="home-authors">
        <div className="home-authors__header">
          <h2 className="home-authors__title">{t('home.recentAuthors.title')}</h2>
        </div>
        <div className="home-authors__grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="home-author-card home-author-card--skeleton">
              <div className="home-author-card__photo" />
              <div className="home-author-card__name" />
            </div>
          ))}
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="home-authors">
        <div className="home-authors__header">
          <h2 className="home-authors__title">{t('home.recentAuthors.title')}</h2>
        </div>
        <p className="home-authors__error">{error}</p>
      </section>
    )
  }

  if (authors.length === 0) {
    return (
      <section className="home-authors">
        <div className="home-authors__header">
          <h2 className="home-authors__title">{t('home.recentAuthors.title')}</h2>
        </div>
        <p className="home-authors__empty">{t('common.noAuthorsYet')}</p>
      </section>
    )
  }

  return (
    <section className="home-authors">
      <div className="home-authors__header">
        <h2 className="home-authors__title">{t('home.recentAuthors.title')}</h2>
        <LocalizedLink to="/authors" className="home-authors__view-all" title="Browse all authors">
          {t('home.recentAuthors.viewAll')} <span className="material-icons-outlined">arrow_forward</span>
        </LocalizedLink>
      </div>
      <div className="home-authors__grid">
        {authors.map((author) => (
          <LocalizedLink key={author.id} to={`/authors/${author.slug}`} className="home-author-card" title={`${author.name} - View biography`}>
            <div className="home-author-card__photo">
              {author.photoPath ? (
                <img src={getStorageUrl(author.photoPath)} alt={author.name} title={`${author.name} - Biography and books`} />
              ) : (
                <span className="home-author-card__initials">{author.name?.[0] || '?'}</span>
              )}
            </div>
            <span className="home-author-card__name">{author.name}</span>
          </LocalizedLink>
        ))}
      </div>
    </section>
  )
}
