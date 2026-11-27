import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { OPENED_AT_KEY, parseOpenedAt, type ReadingProgressDto } from '@textstack/shared'
import { readItem } from '../lib/safeLocalStorage'
import { useHighlightedBook } from '../hooks/useHighlightedBook'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { UploadDropZone } from '../components/library/UploadDropZone'
import { LibrarySidebar } from '../components/library/LibrarySidebar'
import { useLibrarySource } from '../hooks/useLibrarySource'
import { LibraryStatusTabs } from '../components/library/LibraryStatusTabs'
import { LibrarySearch } from '../components/library/LibrarySearch'
import { useLibrarySort } from '../hooks/useLibrarySort'
import { useLibraryStatus } from '../hooks/useLibraryStatus'
import { useLibrarySearch } from '../hooks/useLibrarySearch'
import {
  matchesQuery, parseQuery, buildLibraryEntries, countEntries, filterEntries, sortEntries, type LibraryEntry,
} from '@textstack/shared'
import { UserBookCard } from '../components/library/UserBookCard'
import { BulkActionBar } from '../components/library/BulkActionBar'
import { useLibrarySelection } from '../hooks/useLibrarySelection'
import { EmptyState } from '../components/EmptyState'
import type { UserBook } from '../api/userBooks'
import { platform } from '../platform'
import { LibraryToolbar } from '../components/library/LibraryToolbar'
import { UploadBookListItem } from '../components/library/UploadBookListItem'
import { emitDataChanges, useDataChange } from '../lib/dataEvents'

type ViewMode = 'list' | 'grid'

/** The library is uploads only: no saved catalog books, no catalog progress (the entry helpers are shared with mobile). */
const NO_SAVED: never[] = []
const NO_PROGRESS: Record<string, ReadingProgressDto> = {}

export function LibraryPage() {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth()
  const { language } = useLanguage()
  const { t } = useTranslation()
  const librarySource = useLibrarySource()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const highlightedBookId = useHighlightedBook()
  const [userBooks, setUserBooks] = useState<UserBook[]>([])
  const [userBooksLoading, setUserBooksLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('library-view') as ViewMode) || 'list'
  })
  const { sort, setSort } = useLibrarySort('saved')
  const { status, setStatus } = useLibraryStatus()
  const { query, debouncedQuery: queryD, setQuery, clear: clearQuery } = useLibrarySearch()
  const selection = useLibrarySelection()
  const [bulkBusy, setBulkBusy] = useState(false)

  const onUploadTagSelect = (tag: string | null) => {
    if (!tag) { setQuery(parseQuery(queryD).text); return }
    const text = parseQuery(queryD).text
    setQuery(text ? `tag:${tag} ${text}` : `tag:${tag}`)
  }

  // Persist view mode
  useEffect(() => {
    localStorage.setItem('library-view', viewMode)
  }, [viewMode])

  // Fetch user books
  const fetchUserBooks = useCallback(async () => {
    if (!isAuthenticated) return
    setUserBooksLoading(true)
    try {
      const books = await platform.library.getUserBooks()
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

  // Cross-component refresh: any add/delete/update in user-books anywhere in
  // the app (upload modal, action menu, bulk bar, detail page, etc) refetches
  // here. See lib/dataEvents.ts for the bus.
  useDataChange('user-books', fetchUserBooks)

  // Shared semantics (packages/shared library/entries) — same as mobile.
  const sourceEntries = buildLibraryEntries(NO_SAVED, userBooks, 'uploads')
  const combinedCounts = countEntries(sourceEntries, NO_PROGRESS)
  const combinedItems = filterEntries(sourceEntries, status, NO_PROGRESS).filter((c) =>
    c.kind === 'upload' && (!queryD || matchesQuery({ title: c.book.title, author: c.book.author, tags: c.book.tags }, queryD)))
  const renderList: LibraryEntry<never, UserBook>[] = sortEntries(combinedItems, sort, NO_PROGRESS, parseOpenedAt(readItem(OPENED_AT_KEY)))
  const sortedUserBooks: UserBook[] = renderList.flatMap(c => (c.kind === 'upload' ? [c.book] : []))

  // Bulk handlers (uploads tab) — defined here so sortedUserBooks is in scope
  const runBulk = async (op: () => Promise<void>) => {
    setBulkBusy(true)
    try { await op() } finally { setBulkBusy(false) }
  }
  const ids = () => Array.from(selection.selected)
  const onBulkFinish = () => runBulk(async () => {
    await platform.library.bulkFinishUserBooks(ids(), true)
    selection.exit()
    emitDataChanges(['user-books', 'shelves'])
  })
  const onBulkDelete = () => {
    const titles = userBooks.filter(b => selection.selected.has(b.id)).slice(0, 5).map(b => b.title)
    const more = selection.count - titles.length
    const msg = `Delete ${selection.count} book${selection.count === 1 ? '' : 's'}?\n\n` +
      titles.join('\n') + (more > 0 ? `\n…and ${more} more` : '')
    if (!window.confirm(msg)) return
    runBulk(async () => {
      await platform.library.bulkDeleteUserBooks(ids())
      selection.exit()
      emitDataChanges(['user-books', 'shelves'])
    })
  }
  const onSelectAllVisible = () => selection.selectAll(sortedUserBooks.map(b => ({ id: b.id })))

  useEffect(() => {
    if (!selection.active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        onSelectAllVisible()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.active, sortedUserBooks])

  if (authLoading) {
    return (
      <>
      <div className="library-page">
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
      <div className="library-page">
        <SeoHead title={t('library.title')} noindex />
        <EmptyState icon="📚" title={t('library.title')} subtitle={t('library.signInPrompt')} />
      </div>
      <Footer />
      </>
    )
  }

  return (
    <>
    <div className="library-page library-page--stitch">
      <SeoHead title={t('library.title')} noindex />

      {/* Sidebar */}
      {sidebarOpen && (
        <div
          className="library-sidebar-v3__backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside className={`library-sidebar-v3 ${sidebarOpen ? 'library-sidebar-v3--open' : ''}`}>
        <LibrarySidebar
          source={librarySource.source}
          tag={librarySource.tag}
          counts={{ all: userBooks.length }}
          onSourceChange={(s) => {
            librarySource.setSource(s)
            setSidebarOpen(false)
          }}
          onTagChange={(next) => {
            librarySource.setTag(next)
            setSidebarOpen(false)
            onUploadTagSelect(next)
          }}
        />
      </aside>

      {/* Main Content */}
      <main className="library-main">
        <header className="library-header">
          <button
            type="button"
            className="library-sidebar-toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label={t('library.sidebar.open')}
          >
            <span className="material-icons-outlined">menu</span>
            {t('library.sidebar.open')}
          </button>
          <h1 className="library-header__title">{t('library.title')}</h1>
          {user && <p className="library-header__email">{user.email}</p>}
        </header>

        {(() => {
          const totalRaw = userBooks.length
          const totalVisible = renderList.length
          const isLoadingAny = userBooksLoading && userBooks.length === 0

          return (
            <div id="library-grid" style={{ scrollMarginTop: '90px' }}>
              {/* Toolbar (single, unified) */}
              <LibraryToolbar
                sort={sort}
                onSortChange={setSort}
                showSelectButton={userBooks.length > 0}
                selectionActive={selection.active}
                onToggleSelection={() => selection.active ? selection.exit() : selection.enter()}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                t={t}
              />

              {totalRaw > 0 && (
                <>
                  <LibrarySearch value={query} onChange={setQuery} />
                  <LibraryStatusTabs value={status} onChange={setStatus} counts={combinedCounts} />
                </>
              )}

              {isLoadingAny ? (
                <div className="library-page__loading">{t('library.loading')}</div>
              ) : totalRaw === 0 ? (
                <UploadDropZone />
              ) : totalVisible === 0 ? (
                queryD ? (
                  <div className="library-filters__empty">
                    <p>{t('library.search.empty').replace('{query}', queryD)}</p>
                    <button type="button" onClick={clearQuery}>{t('library.search.clear')}</button>
                  </div>
                ) : (
                  <div className="library-filters__empty">
                    <p>{t('library.filter.empty')}</p>
                    <button type="button" onClick={() => setStatus('all')}>{t('library.filter.clear')}</button>
                  </div>
                )
              ) : viewMode === 'list' ? (
                <div className="library-list">
                  {sortedUserBooks.map((book) => (
                    <UploadBookListItem
                      key={`upload-${book.id}`}
                      book={book}
                      language={language}
                      highlighted={highlightedBookId === book.id}
                      onChange={fetchUserBooks}
                      t={t}
                    />
                  ))}
                </div>
              ) : (
                <div className="library-page__grid">
                  {sortedUserBooks.map((book) => (
                      <UserBookCard
                        key={`upload-${book.id}`}
                        book={book}
                        onDelete={fetchUserBooks}
                        onUpdate={fetchUserBooks}
                        progress={{ percent: book.progressPercent, chapterSlug: book.progressChapterSlug, updatedAt: book.progressUpdatedAt }}
                        highlighted={highlightedBookId === book.id}
                        selectable={selection.active}
                        selected={selection.isSelected(book.id)}
                        onSelectToggle={selection.toggle}
                      />
                  ))}
                </div>
              )}
            </div>
          )
        })()}

      </main>

      {/* FAB */}
      {!selection.active && (
        <button
          className="library-fab"
          onClick={() => window.dispatchEvent(new Event('textstack:open-upload'))}
          aria-label="Upload book"
        >
          <span className="material-icons-outlined">add</span>
        </button>
      )}

      {selection.active && (
        <BulkActionBar
          count={selection.count}
          onCancel={selection.exit}
          onSelectAll={onSelectAllVisible}
          onMarkFinished={onBulkFinish}
          onDelete={onBulkDelete}
          busy={bulkBusy}
        />
      )}
    </div>
    <Footer />
    </>
  )
}
