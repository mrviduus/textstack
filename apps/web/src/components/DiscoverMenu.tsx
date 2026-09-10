import { useState, useEffect, useRef, useCallback } from 'react'
import { LocalizedLink } from './LocalizedLink'
import { useApi } from '../hooks/useApi'
import { useTranslation } from '../hooks/useTranslation'
import { getStorageUrl } from '../api/client'

interface Genre {
  id: string
  slug: string
  name: string
  bookCount: number
}

interface Author {
  id: string
  slug: string
  name: string
  photoPath: string | null
  bookCount: number
}

interface Edition {
  id: string
  slug: string
  title: string
  coverPath: string | null
}

export function DiscoverMenu() {
  const { t } = useTranslation()
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [genres, setGenres] = useState<Genre[]>([])
  const [authors, setAuthors] = useState<Author[]>([])
  const [recentCovers, setRecentCovers] = useState<string[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Fetch data once on first open
  const [fetched, setFetched] = useState(false)
  useEffect(() => {
    if (!open || fetched) return
    setFetched(true)

    Promise.all([
      api.getGenres(),
      api.getAuthors({ limit: 6, sort: 'recent' }),
      api.getBooks({ limit: 8 }),
    ])
      .then(([g, a, b]) => {
        setGenres(g.items.slice(0, 12))
        setAuthors(a.items)
        const covers = (b.items as Edition[])
          .map(e => getStorageUrl(e.coverPath))
          .filter((c): c is string => !!c)
          .slice(0, 6)
        setRecentCovers(covers)
      })
      .catch(() => {})
  }, [open, fetched, api])

  const handleEnter = useCallback(() => {
    clearTimeout(timerRef.current)
    setOpen(true)
  }, [])

  const handleLeave = useCallback(() => {
    timerRef.current = setTimeout(() => setOpen(false), 200)
  }, [])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  return (
    <div
      className="discover-menu"
      ref={containerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        className={`site-header__nav-link discover-menu__trigger${open ? ' discover-menu__trigger--open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {t('nav.discover')}
        <span className="discover-menu__chevron" aria-hidden="true">
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
            <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>

      {open && (
        <div className="discover-menu__panel" role="menu">
          {/* Column 1: Genres */}
          <div className="discover-menu__col">
            <h3 className="discover-menu__col-title">{t('nav.discoverMenu.trendingGenres')}</h3>
            <ul className="discover-menu__list">
              {genres.map(g => (
                <li key={g.id}>
                  <LocalizedLink
                    to={`/genres/${g.slug}`}
                    className="discover-menu__link"
                    onClick={() => setOpen(false)}
                  >
                    {g.name}
                  </LocalizedLink>
                </li>
              ))}
              {genres.length > 0 && (
                <li>
                  <LocalizedLink
                    to="/genres"
                    className="discover-menu__link discover-menu__link--all"
                    onClick={() => setOpen(false)}
                  >
                    {t('nav.discoverMenu.allGenres')} &rarr;
                  </LocalizedLink>
                </li>
              )}
            </ul>
          </div>

          {/* Column 2: Quick Links / Curated */}
          <div className="discover-menu__col">
            <h3 className="discover-menu__col-title">{t('nav.discoverMenu.quickLinks')}</h3>
            <ul className="discover-menu__list">
              <li>
                <LocalizedLink to="/authors" className="discover-menu__link" onClick={() => setOpen(false)}>
                  {t('nav.discoverMenu.latestAuthors')}
                </LocalizedLink>
              </li>
              <li>
                <LocalizedLink to="/books" className="discover-menu__link" onClick={() => setOpen(false)}>
                  {t('nav.discoverMenu.allBooks')}
                </LocalizedLink>
              </li>
              <li>
                <LocalizedLink to="/books?sort=popular" className="discover-menu__link" onClick={() => setOpen(false)}>
                  {t('nav.discoverMenu.topFreeBooks')}
                </LocalizedLink>
              </li>
            </ul>
          </div>

          {/* Column 3: Latest Authors with cover collage */}
          <div className="discover-menu__col discover-menu__col--featured">
            <h3 className="discover-menu__col-title">{t('nav.discoverMenu.browseAuthors')}</h3>
            <p className="discover-menu__col-subtitle">{t('nav.discoverMenu.browseAuthorsDesc')}</p>

            {recentCovers.length > 0 && (
              <LocalizedLink to="/books" className="discover-menu__covers" onClick={() => setOpen(false)}>
                {recentCovers.map((src, i) => (
                  <img
                    key={i}
                    src={src}
                    alt=""
                    className="discover-menu__cover-img"
                    loading="lazy"
                  />
                ))}
              </LocalizedLink>
            )}

            {authors.length > 0 && (
              <div className="discover-menu__authors-row">
                {authors.slice(0, 4).map(a => (
                  <LocalizedLink
                    key={a.id}
                    to={`/authors/${a.slug}`}
                    className="discover-menu__author-chip"
                    onClick={() => setOpen(false)}
                  >
                    {a.name}
                  </LocalizedLink>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
