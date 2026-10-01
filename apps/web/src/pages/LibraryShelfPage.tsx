import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { useLibraryShelves } from '../hooks/useLibraryShelves'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { EmptyState } from '../components/EmptyState'
import { getStorageUrl } from '../api/client'
import { getUserBookCoverUrl } from '../api/userBooks'
import { stringToColor } from '../utils/colors'
import type { LibraryShelfItem, LibraryShelves as Shelves } from '@textstack/shared'

type ShelfId = keyof Shelves

const VALID_SHELVES: ShelfId[] = ['continueReading', 'recentlyAdded', 'quickReads', 'finishedThisMonth']

function isValidShelf(s: string | undefined): s is ShelfId {
  return !!s && (VALID_SHELVES as string[]).includes(s)
}

function itemHref(it: LibraryShelfItem): string {
  if (it.type === 'userbook') return `/library/my/${it.id}`
  return `/books/${it.slug ?? ''}`
}

function itemCover(it: LibraryShelfItem): string | undefined {
  if (!it.coverPath) return undefined
  return it.type === 'userbook' ? getUserBookCoverUrl(it.coverPath) : getStorageUrl(it.coverPath)
}

export function LibraryShelfPage() {
  const { shelfId } = useParams<{ shelfId: string }>()
  const { isAuthenticated, isLoading } = useAuth()
  const { language } = useLanguage()
  const { t } = useTranslation()
  const { shelves, loading } = useLibraryShelves()

  if (isLoading) {
    return (
      <>
        <div className="library-shelf-page">
          <SeoHead title={t('library.title')} noindex />
          <div className="library-page__loading">{t('library.loading')}</div>
        </div>
        <Footer />
      </>
    )
  }

  if (!isAuthenticated) {
    return (
      <>
        <div className="library-shelf-page">
          <SeoHead title={t('library.title')} noindex />
          <EmptyState icon="📚" title={t('library.title')} subtitle={t('library.signInPrompt')} />
        </div>
        <Footer />
      </>
    )
  }

  if (!isValidShelf(shelfId)) {
    return (
      <>
        <div className="library-shelf-page">
          <SeoHead title={t('library.title')} noindex />
          <EmptyState icon="❓" title="Unknown shelf" buttonLabel={t('breadcrumbs.home')} buttonTo="/library" />
        </div>
        <Footer />
      </>
    )
  }

  const title = t(`library.shelves.${shelfId}.title`)
  const subtitle = t(`library.shelves.${shelfId}.subtitle`)
  const items = shelves?.[shelfId] ?? []

  return (
    <>
      <div className="library-shelf-page">
        <SeoHead title={title} noindex />

        <div className="library-shelf-page__header">
          <Link to={`/${language}/library`} className="library-shelf-page__back-link">
            ← {t('library.title')}
          </Link>
          <h1 className="library-shelf-page__title">{title}</h1>
          <p className="library-shelf-page__subtitle">{subtitle}</p>
          {!loading && items.length > 0 && (
            <p className="library-shelf-page__count">{items.length} books</p>
          )}
        </div>

        {loading && items.length === 0 ? (
          <div className="library-page__loading">{t('library.loading')}</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="📖"
            title={t('library.shelves.empty.title')}
            buttonLabel={t('library.shelves.empty.browseCatalog')}
            buttonTo="/library"
          />
        ) : (
          <div className="library-shelf-page__grid">
            {items.map((it) => {
              const cover = itemCover(it)
              const percent = Math.round(it.progressPercent * 100)
              const showProgress = it.progressPercent > 0 && it.progressPercent < 1
              return (
                <LocalizedLink key={`${it.type}-${it.id}`} to={itemHref(it)} className="library-card">
                  <div
                    className="library-card__cover"
                    style={{ backgroundColor: cover ? undefined : stringToColor(it.title) }}
                  >
                    {cover ? (
                      <img src={cover} alt={it.title} loading="lazy" />
                    ) : (
                      <div
                        className="library-card__cover-placeholder"
                        style={{ backgroundColor: stringToColor(it.title) }}
                      >
                        {it.title?.[0] || '?'}
                      </div>
                    )}
                    {showProgress && (
                      <div className="library-card__progress-bar">
                        <div className="library-card__progress-fill" style={{ width: `${percent}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="library-card__info">
                    <div className="library-card__text">
                      <span className="library-card__title">{it.title}</span>
                      {it.author && <span className="library-card__meta">{it.author}</span>}
                      {showProgress && (
                        <span className="library-card__progress-text">
                          {percent}% {t('library.read')}
                        </span>
                      )}
                    </div>
                  </div>
                </LocalizedLink>
              )
            })}
          </div>
        )}
      </div>
      <Footer />
    </>
  )
}
