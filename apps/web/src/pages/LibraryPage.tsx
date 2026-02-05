import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLibrary } from '../hooks/useLibrary'
import { useApi } from '../hooks/useApi'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { OfflineBadge } from '../components/OfflineBadge'
import { BookCardMenu } from '../components/library/BookCardMenu'
import { UploadSection } from '../components/library/UploadSection'
import { UserBookCard } from '../components/library/UserBookCard'
import { getStorageUrl } from '../api/client'
import { getUserBooks, getUserBookCoverUrl, getUserBookProgress, type UserBook, type UserBookProgress } from '../api/userBooks'
import { stringToColor } from '../utils/colors'
import { getAllProgress, ReadingProgressDto, markAsRead, markAsUnread } from '../api/auth'

type ViewMode = 'list' | 'grid'
type SortOption = 'recent' | 'title' | 'progress'
type SidebarTab = 'saved' | 'uploads'

export function LibraryPage() {
  const { isAuthenticated, user } = useAuth()
  const { items, loading, remove } = useLibrary()
  const api = useApi()
  const [progressMap, setProgressMap] = useState<Record<string, ReadingProgressDto>>({})
  const [activeTab, setActiveTab] = useState<SidebarTab>('saved')
  const [userBooks, setUserBooks] = useState<UserBook[]>([])
  const [userBooksLoading, setUserBooksLoading] = useState(false)
  const [userBookProgress, setUserBookProgress] = useState<Record<string, UserBookProgress>>({})

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('library-view') as ViewMode) || 'list'
  })
  const [sortBy, setSortBy] = useState<SortOption>('recent')
  const [showSortMenu, setShowSortMenu] = useState(false)
  const [showUploadModal, setShowUploadModal] = useState(false)

  // Persist view mode
  useEffect(() => {
    localStorage.setItem('library-view', viewMode)
  }, [viewMode])

  // Fetch user books
  const fetchUserBooks = useCallback(async () => {
    if (!isAuthenticated) return
    setUserBooksLoading(true)
    try {
      const books = await getUserBooks()
      setUserBooks(books)
    } catch {
      // Ignore errors
    } finally {
      setUserBooksLoading(false)
    }
  }, [isAuthenticated])

  useEffect(() => {
    fetchUserBooks()
  }, [fetchUserBooks])

  // Fetch progress for ready user books
  useEffect(() => {
    const readyBooks = userBooks.filter(b => b.status === 'Ready')
    if (readyBooks.length === 0) return

    readyBooks.forEach(async (book) => {
      if (userBookProgress[book.id]) return // already fetched
      const progress = await getUserBookProgress(book.id)
      if (progress) {
        setUserBookProgress(prev => ({ ...prev, [book.id]: progress }))
      }
    })
  }, [userBooks])

  // Auto-refresh processing books
  useEffect(() => {
    const processingBooks = userBooks.filter(b => b.status === 'Processing')
    if (processingBooks.length === 0) return

    const interval = setInterval(fetchUserBooks, 5000)
    return () => clearInterval(interval)
  }, [userBooks, fetchUserBooks])

  // Mark book as read
  const handleMarkRead = useCallback(async (editionId: string, slug: string) => {
    try {
      const book = await api.getBook(slug)
      if (book.chapters.length === 0) return
      const lastChapter = book.chapters[book.chapters.length - 1]
      const result = await markAsRead(editionId, lastChapter.id)
      setProgressMap(prev => ({ ...prev, [editionId]: result }))
    } catch (err) {
      console.error('Failed to mark as read:', err)
    }
  }, [api])

  // Mark book as unread
  const handleMarkUnread = useCallback(async (editionId: string, slug: string) => {
    try {
      const book = await api.getBook(slug)
      if (book.chapters.length === 0) return
      const firstChapter = book.chapters[0]
      const result = await markAsUnread(editionId, firstChapter.id)
      setProgressMap(prev => ({ ...prev, [editionId]: result }))
    } catch (err) {
      console.error('Failed to mark as unread:', err)
    }
  }, [api])

  // Fetch all reading progress
  useEffect(() => {
    if (!isAuthenticated) return
    getAllProgress()
      .then((res) => {
        const map: Record<string, ReadingProgressDto> = {}
        res.items.forEach((p) => {
          map[p.editionId] = p
        })
        setProgressMap(map)
      })
      .catch(() => {})
  }, [isAuthenticated])

  // Sort items
  const sortedItems = [...items].sort((a, b) => {
    switch (sortBy) {
      case 'title':
        return a.title.localeCompare(b.title)
      case 'progress':
        const pA = progressMap[a.editionId]?.percent ?? 0
        const pB = progressMap[b.editionId]?.percent ?? 0
        return pB - pA
      default:
        return 0
    }
  })

  // Sort user books
  const sortedUserBooks = [...userBooks].sort((a, b) => {
    switch (sortBy) {
      case 'title':
        return a.title.localeCompare(b.title)
      default:
        return 0
    }
  })

  const sortLabels: Record<SortOption, string> = {
    recent: 'Recently Added',
    title: 'Title',
    progress: 'Progress'
  }

  if (!isAuthenticated) {
    return (
      <>
      <div className="library-page">
        <SeoHead title="My Library" noindex />
        <div className="library-page__empty">
          <h1>My Library</h1>
          <p>Sign in to save books to your library and track your reading progress.</p>
        </div>
      </div>
      <Footer />
      </>
    )
  }

  return (
    <>
    <div className="library-page library-page--stitch">
      <SeoHead title="My Library" noindex />

      {/* Sidebar */}
      <aside className="library-sidebar">
        <div className="library-sidebar__inner">
          <button
            className={`library-sidebar__btn ${activeTab === 'saved' ? 'library-sidebar__btn--active' : ''}`}
            onClick={() => setActiveTab('saved')}
          >
            <span className="material-icons-outlined">book</span>
            <span>Saved</span>
            {items.length > 0 && <span className="library-sidebar__count">{items.length}</span>}
          </button>
          <button
            className={`library-sidebar__btn ${activeTab === 'uploads' ? 'library-sidebar__btn--active' : ''}`}
            onClick={() => setActiveTab('uploads')}
          >
            <span className="material-icons-outlined">file_upload</span>
            <span>Uploads</span>
            {userBooks.length > 0 && <span className="library-sidebar__count">{userBooks.length}</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="library-main">
        <header className="library-header">
          <h1 className="library-header__title">My Library</h1>
          {user && <p className="library-header__email">{user.email}</p>}
        </header>

        {activeTab === 'saved' && (
          <>
            {/* Toolbar */}
            <div className="library-toolbar">
              <div className="library-toolbar__left">
                <div className="library-sort">
                  <button
                    className="library-sort__trigger"
                    onClick={() => setShowSortMenu(!showSortMenu)}
                  >
                    Sort by: {sortLabels[sortBy]}
                    <span className="material-icons-outlined">expand_more</span>
                  </button>
                  {showSortMenu && (
                    <>
                      <div className="library-sort__backdrop" onClick={() => setShowSortMenu(false)} />
                      <div className="library-sort__menu">
                        {(Object.keys(sortLabels) as SortOption[]).map((key) => (
                          <button
                            key={key}
                            className={`library-sort__option ${sortBy === key ? 'library-sort__option--active' : ''}`}
                            onClick={() => { setSortBy(key); setShowSortMenu(false) }}
                          >
                            {sortLabels[key]}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="library-toolbar__right">
                <button
                  className={`library-view-btn ${viewMode === 'grid' ? 'library-view-btn--active' : ''}`}
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"
                >
                  <span className="material-icons-outlined">grid_view</span>
                </button>
                <button
                  className={`library-view-btn ${viewMode === 'list' ? 'library-view-btn--active' : ''}`}
                  onClick={() => setViewMode('list')}
                  aria-label="List view"
                >
                  <span className="material-icons-outlined">format_list_bulleted</span>
                </button>
              </div>
            </div>

            {loading ? (
              <div className="library-page__loading">Loading...</div>
            ) : sortedItems.length === 0 ? (
              <div className="library-page__empty">
                <p>Your library is empty.</p>
                <LocalizedLink to="/books" className="library-page__browse-btn" title="Browse all books">
                  Browse Books
                </LocalizedLink>
              </div>
            ) : viewMode === 'list' ? (
              <div className="library-list">
                {sortedItems.map((item) => {
                  const progress = progressMap[item.editionId]
                  const percent = progress?.percent ?? 0
                  const destination = progress?.chapterSlug
                    ? `/${item.language}/books/${item.slug}/${progress.chapterSlug}`
                    : `/${item.language}/books/${item.slug}`
                  return (
                    <article key={item.editionId} className="library-list-item">
                      <Link to={destination} className="library-list-item__cover">
                        {item.coverPath ? (
                          <img src={getStorageUrl(item.coverPath)} alt={item.title} />
                        ) : (
                          <div
                            className="library-list-item__cover-placeholder"
                            style={{ backgroundColor: stringToColor(item.title) }}
                          >
                            {item.title?.[0] || '?'}
                          </div>
                        )}
                      </Link>
                      <div className="library-list-item__content">
                        <Link to={destination} className="library-list-item__title">
                          {item.title}
                        </Link>

                        {/* Progress bar */}
                        <div className="library-list-item__progress">
                          <div className="library-list-item__progress-header">
                            <span>Reading Progress</span>
                            <span className="library-list-item__progress-percent">{Math.round(percent * 100)}%</span>
                          </div>
                          <div className="library-list-item__progress-bar">
                            <div
                              className="library-list-item__progress-fill"
                              style={{ width: `${Math.round(percent * 100)}%` }}
                            />
                          </div>
                        </div>

                        <div className="library-list-item__info">
                          {progress?.updatedAt && (
                            <span className="library-list-item__info-item">
                              <span className="material-icons-outlined">schedule</span>
                              Last read {formatTimeAgo(progress.updatedAt)}
                            </span>
                          )}
                          <OfflineBadge editionId={item.editionId} />
                        </div>
                      </div>
                      <div className="library-list-item__actions">
                        <BookCardMenu
                          book={item}
                          isRead={percent >= 1}
                          onRemove={() => remove(item.editionId)}
                          onMarkRead={() => handleMarkRead(item.editionId, item.slug)}
                          onMarkUnread={() => handleMarkUnread(item.editionId, item.slug)}
                        />
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : (
              <div className="library-page__grid">
                {sortedItems.map((item) => {
                  const progress = progressMap[item.editionId]
                  const percent = progress?.percent ?? 0
                  const destination = progress?.chapterSlug
                    ? `/${item.language}/books/${item.slug}/${progress.chapterSlug}`
                    : `/${item.language}/books/${item.slug}`
                  return (
                    <div key={item.editionId} className="library-card">
                      <Link to={destination} className="library-card__cover" title={`Read ${item.title} online`}>
                        {item.coverPath ? (
                          <img src={getStorageUrl(item.coverPath)} alt={item.title} />
                        ) : (
                          <div
                            className="library-card__cover-placeholder"
                            style={{ backgroundColor: stringToColor(item.title) }}
                          >
                            {item.title?.[0] || '?'}
                          </div>
                        )}
                        {percent > 0 && (
                          <div className="library-card__progress-bar">
                            <div
                              className="library-card__progress-fill"
                              style={{ width: `${Math.round(percent * 100)}%` }}
                            />
                          </div>
                        )}
                      </Link>
                      <div className="library-card__info">
                        <div className="library-card__text">
                          <Link to={destination} className="library-card__title">
                            {item.title}
                          </Link>
                          <div className="library-card__meta">
                            {percent > 0 && (
                              <span className="library-card__progress-text">
                                {Math.round(percent * 100)}% read
                              </span>
                            )}
                            <OfflineBadge editionId={item.editionId} />
                          </div>
                        </div>
                        <BookCardMenu
                          book={item}
                          isRead={percent >= 1}
                          onRemove={() => remove(item.editionId)}
                          onMarkRead={() => handleMarkRead(item.editionId, item.slug)}
                          onMarkUnread={() => handleMarkUnread(item.editionId, item.slug)}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {activeTab === 'uploads' && (
          <>
            {showUploadModal && (
              <UploadSection onUploadComplete={() => { fetchUserBooks(); setShowUploadModal(false) }} />
            )}

            {/* Toolbar */}
            <div className="library-toolbar">
              <div className="library-toolbar__left">
                <div className="library-sort">
                  <button
                    className="library-sort__trigger"
                    onClick={() => setShowSortMenu(!showSortMenu)}
                  >
                    Sort by: {sortLabels[sortBy]}
                    <span className="material-icons-outlined">expand_more</span>
                  </button>
                  {showSortMenu && (
                    <>
                      <div className="library-sort__backdrop" onClick={() => setShowSortMenu(false)} />
                      <div className="library-sort__menu">
                        {(Object.keys(sortLabels) as SortOption[]).map((key) => (
                          <button
                            key={key}
                            className={`library-sort__option ${sortBy === key ? 'library-sort__option--active' : ''}`}
                            onClick={() => { setSortBy(key); setShowSortMenu(false) }}
                          >
                            {sortLabels[key]}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="library-toolbar__right">
                <button
                  className={`library-view-btn ${viewMode === 'grid' ? 'library-view-btn--active' : ''}`}
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"
                >
                  <span className="material-icons-outlined">grid_view</span>
                </button>
                <button
                  className={`library-view-btn ${viewMode === 'list' ? 'library-view-btn--active' : ''}`}
                  onClick={() => setViewMode('list')}
                  aria-label="List view"
                >
                  <span className="material-icons-outlined">format_list_bulleted</span>
                </button>
              </div>
            </div>

            {userBooksLoading && userBooks.length === 0 ? (
              <div className="library-page__loading">Loading...</div>
            ) : userBooks.length === 0 ? (
              <div className="library-page__empty">
                <p>No uploaded books yet.</p>
                <p className="library-page__empty-hint">
                  Click the + button to upload EPUB files.
                </p>
              </div>
            ) : viewMode === 'list' ? (
              <div className="library-list">
                {sortedUserBooks.map((book) => {
                  const isReady = book.status === 'Ready'
                  const progress = userBookProgress[book.id]
                  const percent = progress?.percent ?? 0
                  const destination = isReady
                    ? (progress?.chapterSlug ? `/en/library/my/${book.id}/read/${progress.chapterSlug}` : `/en/library/my/${book.id}`)
                    : '#'
                  const coverUrl = getUserBookCoverUrl(book.coverPath)
                  return (
                    <article key={book.id} className="library-list-item">
                      {isReady ? (
                        <Link to={destination} className="library-list-item__cover">
                          {coverUrl ? (
                            <img
                              src={coverUrl}
                              alt={book.title}
                              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden') }}
                            />
                          ) : null}
                          <div
                            className={`library-list-item__cover-placeholder ${coverUrl ? 'hidden' : ''}`}
                            style={{ backgroundColor: stringToColor(book.title) }}
                          >
                            {book.title?.[0] || '?'}
                          </div>
                        </Link>
                      ) : (
                        <div className="library-list-item__cover library-list-item__cover--disabled">
                          {coverUrl ? (
                            <img
                              src={coverUrl}
                              alt={book.title}
                              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden') }}
                            />
                          ) : null}
                          <div
                            className={`library-list-item__cover-placeholder ${coverUrl ? 'hidden' : ''}`}
                            style={{ backgroundColor: stringToColor(book.title) }}
                          >
                            {book.title?.[0] || '?'}
                          </div>
                        </div>
                      )}
                      <div className="library-list-item__content">
                        {isReady ? (
                          <Link to={destination} className="library-list-item__title">
                            {book.title}
                          </Link>
                        ) : (
                          <span className="library-list-item__title">{book.title}</span>
                        )}

                        {/* Progress bar for ready books */}
                        {isReady && (
                          <div className="library-list-item__progress">
                            <div className="library-list-item__progress-header">
                              <span>Reading Progress</span>
                              <span className="library-list-item__progress-percent">{Math.round(percent * 100)}%</span>
                            </div>
                            <div className="library-list-item__progress-bar">
                              <div
                                className="library-list-item__progress-fill"
                                style={{ width: `${Math.round(percent * 100)}%` }}
                              />
                            </div>
                          </div>
                        )}

                        <div className="library-list-item__info">
                          {book.chapterCount > 0 && (
                            <span className="library-list-item__info-item">
                              {book.chapterCount} chapters
                            </span>
                          )}
                          {isReady && progress?.updatedAt && (
                            <span className="library-list-item__info-item">
                              <span className="material-icons-outlined">schedule</span>
                              Last read {formatTimeAgo(progress.updatedAt)}
                            </span>
                          )}
                          {book.status === 'Processing' && (
                            <span className="library-list-item__info-item library-list-item__info-item--processing">
                              <span className="material-icons-outlined">sync</span>
                              Processing...
                            </span>
                          )}
                          {book.status === 'Failed' && (
                            <span className="library-list-item__info-item library-list-item__info-item--error">
                              <span className="material-icons-outlined">error</span>
                              Failed
                            </span>
                          )}
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : (
              <div className="library-page__grid">
                {sortedUserBooks.map((book) => (
                  <UserBookCard
                    key={book.id}
                    book={book}
                    onDelete={fetchUserBooks}
                    onRetry={fetchUserBooks}
                    progress={userBookProgress[book.id]}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* FAB */}
      {activeTab === 'uploads' && (
        <button
          className="library-fab"
          onClick={() => setShowUploadModal(true)}
          aria-label="Upload book"
        >
          <span className="material-icons-outlined">add</span>
        </button>
      )}
    </div>
    <Footer />
    </>
  )
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins} min ago`
  if (diffHours < 24) return `${diffHours} hours ago`
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return date.toLocaleDateString()
}
