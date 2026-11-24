import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { getAllHighlights, type HighlightListItem } from '../api/userData'
import { syncApi } from '@textstack/shared'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { EmptyState } from '../components/EmptyState'
import { useDataChange } from '../lib/dataEvents'
import { HighlightQuote } from '../components/HighlightQuote'

const COLORS = ['yellow', 'green', 'pink', 'blue'] as const
const PAGE_SIZE = 50

interface BookGroup {
  bookId: string
  bookTitle: string
  coverUrl: string | null
  isUserBook: boolean
  highlights: HighlightListItem[]
}

export function HighlightsPage({ embedded }: { embedded?: boolean } = {}) {
  const { isAuthenticated } = useAuth()
  const { t } = useTranslation()
  const { language, getLocalizedPath } = useLanguage()
  const navigate = useNavigate()

  const [highlights, setHighlights] = useState<HighlightListItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [colorFilter, setColorFilter] = useState<string | ''>('')
  const [offset, setOffset] = useState(0)
  const [collapsedBooks, setCollapsedBooks] = useState<Set<string>>(new Set())

  const fetchHighlights = useCallback(async (reset = false) => {
    try {
      setLoading(true)
      const newOffset = reset ? 0 : offset
      const result = await getAllHighlights({
        limit: PAGE_SIZE,
        offset: newOffset,
        sort: 'newest',
        search: search || undefined,
        color: colorFilter || undefined,
      })
      if (reset) {
        setHighlights(result.items)
        setOffset(PAGE_SIZE)
      } else {
        setHighlights(prev => [...prev, ...result.items])
        setOffset(prev => prev + PAGE_SIZE)
      }
      setTotalCount(result.totalCount)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [search, colorFilter, offset])

  useEffect(() => {
    if (!isAuthenticated) return
    setOffset(0)
    fetchHighlights(true)
  }, [isAuthenticated, search, colorFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // Highlights added/removed in the reader (or any other surface) re-pull
  // the list so this page stays current without remount.
  useDataChange('highlights', () => {
    setOffset(0)
    fetchHighlights(true)
  })

  // Group by book
  const groups: BookGroup[] = []
  const bookMap = new Map<string, BookGroup>()
  for (const h of highlights) {
    // A deleted book has no id left; its kept title tells its highlights apart from another's.
    const bookId = h.userBookId || h.editionId || (h.deletedBookTitle ? `deleted:${h.deletedBookTitle}` : 'unknown')
    let group = bookMap.get(bookId)
    if (!group) {
      group = {
        bookId,
        bookTitle: h.userBookTitle || h.editionTitle || (h.deletedBookTitle ? `${h.deletedBookTitle} (deleted)` : 'Unknown Book'),
        // Keyed as the library's cover, so it is fetched and cached once (#1580).
        coverUrl: h.userBookId && h.userBookCoverVersion ? syncApi.coverUrl(h.userBookId, h.userBookCoverVersion) : null,
        isUserBook: !!h.userBookId,
        highlights: [],
      }
      bookMap.set(bookId, group)
      groups.push(group)
    }
    group.highlights.push(h)
  }

  const toggleBook = (bookId: string) => {
    setCollapsedBooks(prev => {
      const next = new Set(prev)
      if (next.has(bookId)) next.delete(bookId)
      else next.add(bookId)
      return next
    })
  }

  const navigateToHighlight = (h: HighlightListItem) => {
    const path = highlightReaderPath(h)
    if (path) navigate(getLocalizedPath(path))
  }

  if (!embedded && !isAuthenticated) {
    return (
      <>
        <div className="highlights-page">
          <SeoHead title={t('highlights.title')} noindex />
          <EmptyState
            icon="🎨"
            title={t('highlights.empty.title')}
            subtitle={t('highlights.empty.subtitle')}
            buttonLabel={t('highlights.empty.cta')}
            buttonTo="/library"
          />
        </div>
        <Footer />
      </>
    )
  }

  const highlightsContent = (
      <div className="highlights-page">
        {!embedded && <SeoHead title={t('highlights.title')} noindex />}

        <div className="highlights-page__header">
          {!embedded && <h1>{t('highlights.title')}</h1>}
        </div>

        <div className="highlights-page__filters">
          <div className="highlights-page__search-row">
            <input
              type="text"
              className="highlights-page__search"
              placeholder={t('highlights.search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />

            <select
              className="highlights-page__color-filter"
              value={colorFilter}
              onChange={e => setColorFilter(e.target.value)}
            >
              <option value="">{t('highlights.filterByColor')}</option>
              {COLORS.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        {loading && highlights.length === 0 ? (
          <div className="highlights-page__loading">{t('common.loading')}</div>
        ) : highlights.length === 0 ? (
          <EmptyState icon="🎨" title={t('highlights.empty.title')} />
        ) : (
          <div className="highlights-page__groups">
            {groups.map(group => (
              <div key={group.bookId} className="highlights-page__book-group">
                <button
                  className="highlights-page__book-header"
                  onClick={() => toggleBook(group.bookId)}
                >
                  {group.coverUrl && (
                    <img
                      className="highlights-page__book-cover"
                      src={group.coverUrl}
                      alt=""
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  )}
                  <div className="highlights-page__book-info">
                    <span className="highlights-page__book-title">{group.bookTitle}</span>
                    <span className="highlights-page__book-count">
                      {t('highlights.highlightCount').replace('{count}', String(group.highlights.length))}
                    </span>
                  </div>
                  <span className={`highlights-page__chevron ${collapsedBooks.has(group.bookId) ? '' : 'highlights-page__chevron--open'}`}>
                    &#9654;
                  </span>
                </button>

                {!collapsedBooks.has(group.bookId) && (
                  <div className="highlights-page__highlight-list">
                    {group.highlights.map(h => (
                      <div
                        key={h.id}
                        className="highlights-page__highlight"
                        onClick={() => navigateToHighlight(h)}
                      >
                        <div className={`highlights-page__color-bar highlights-page__color-bar--${h.color}`} />
                        <div className="highlights-page__highlight-content">
                          <p className="highlights-page__text">
                            <HighlightQuote anchorJson={h.anchorJson} selectedText={h.selectedText} />
                          </p>
                          {h.noteText && (
                            <p className="highlights-page__note">
                              <span className="highlights-page__note-label">{t('highlights.note')}:</span> {h.noteText}
                            </p>
                          )}
                          <div className="highlights-page__meta">
                            <span>{h.chapterTitle || h.userChapterTitle || ''}</span>
                            <span>{new Date(h.createdAt).toLocaleDateString(language)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {highlights.length < totalCount && (
              <button
                className="highlights-page__load-more"
                onClick={() => fetchHighlights(false)}
                disabled={loading}
              >
                {loading ? t('common.loading') : t('highlights.loadMore')}
              </button>
            )}
          </div>
        )}
      </div>
  )

  if (embedded) return highlightsContent

  return (
    <>
      {highlightsContent}
      <Footer />
    </>
  )
}

/** Where a highlight opens (unprefixed): its upload in the reader, which jumps to `?highlight`. */
export function highlightReaderPath(h: HighlightListItem): string | null {
  if (h.userBookId && h.userChapterSlug) return `/library/my/${h.userBookId}/read/${h.userChapterSlug}?direct=1&highlight=${h.id}`
  if (h.userBookId) return `/library/my/${h.userBookId}/read?direct=1&highlight=${h.id}`
  return null
}
