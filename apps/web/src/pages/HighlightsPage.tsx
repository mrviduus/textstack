import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { getAllHighlights, type HighlightListItem } from '../api/userData'
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
  coverPath: string | null
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
  const [activeTab, setActiveTab] = useState<'all' | 'edition' | 'userbook'>('all')
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
        bookType: activeTab,
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
  }, [activeTab, search, colorFilter, offset])

  useEffect(() => {
    if (!isAuthenticated) return
    setOffset(0)
    fetchHighlights(true)
  }, [isAuthenticated, activeTab, search, colorFilter]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const bookId = h.userBookId || h.editionId || 'unknown'
    let group = bookMap.get(bookId)
    if (!group) {
      group = {
        bookId,
        bookTitle: h.userBookTitle || h.editionTitle || 'Unknown Book',
        coverPath: h.userBookCoverPath || h.editionCoverPath || null,
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
            buttonTo="/books"
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
          <div className="vocab-review-actions">
            <button
              className="vocab-review-btn"
              onClick={() => navigate(getLocalizedPath('/highlights/review'))}
              disabled={totalCount === 0}
            >
              {t('highlights.reviewButton')}
            </button>
          </div>
        </div>

        <div className="highlights-page__filters">
          <div className="highlights-page__tabs">
            {(['all', 'edition', 'userbook'] as const).map(tab => (
              <button
                key={tab}
                className={`highlights-page__tab ${activeTab === tab ? 'highlights-page__tab--active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'all' ? t('highlights.all') : tab === 'edition' ? t('highlights.libraryBooks') : t('highlights.myBooks')}
              </button>
            ))}
          </div>

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
                  {group.coverPath && (
                    <img
                      className="highlights-page__book-cover"
                      src={`/storage/${group.coverPath}`}
                      alt=""
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

/**
 * Where a highlight opens (unprefixed). The catalog reader is `/books/:slug/:chapter` — there is no
 * `/read/` segment there (that is uploads only); the old `/books/:slug/read/:chapter` was a 404.
 */
export function highlightReaderPath(h: HighlightListItem): string | null {
  if (h.editionId && h.editionSlug && h.chapterSlug) return `/books/${h.editionSlug}/${h.chapterSlug}?direct=1&highlight=${h.id}`
  if (h.editionId && h.editionSlug) return `/books/${h.editionSlug}`
  if (h.userBookId && h.userChapterSlug) return `/library/my/${h.userBookId}/read/${h.userChapterSlug}?direct=1&highlight=${h.id}`
  // Chapterless (Original-layout PDF) highlight — ReaderPage reads ?highlight and scrolls to the anchor's page.
  if (h.userBookId) return `/library/my/${h.userBookId}/read?direct=1&highlight=${h.id}`
  return null
}
