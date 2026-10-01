import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatTimeAgo } from '@textstack/shared'
import type { UserBook } from '../../api/userBooks'
import { deleteUserBook, markUserBookRead, getUserBookCoverUrl } from '../../api/userBooks'
import { emitDataChanges } from '../../lib/dataEvents'

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

export type CardState =
  | { kind: 'processing' }
  | { kind: 'failed' }
  | { kind: 'read' }
  | { kind: 'inProgress'; percent: number } // 0..100
  | { kind: 'new' }

/**
 * Badge/state for a Read later card. Order matters: Processing/Failed win over
 * read state; then Read; then an in-progress % bar; else New (unread).
 */
export function cardState(book: UserBook): CardState {
  if (book.status === 'Processing') return { kind: 'processing' }
  if (book.status === 'Failed') return { kind: 'failed' }
  if (book.isRead) return { kind: 'read' }
  const percent = book.progressPercent ?? 0
  if (percent > 0) return { kind: 'inProgress', percent: Math.round(percent * 100) }
  return { kind: 'new' }
}

/** Hostname of a clip's source URL, sans leading www. Null on missing/parse error. */
export function sourceDomain(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Estimated read time in minutes at ~200 wpm, floored at 1. */
export function estReadMinutes(totalWordCount: number | null | undefined): number {
  return Math.max(1, Math.round((totalWordCount ?? 0) / 200))
}

/** http(s) guard for rendering an external <a> (backend validates; defence-in-depth). */
export function isHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  books: UserBook[]
  language: string
  loading: boolean
  unreadOnly: boolean
  onToggleUnread: () => void
  onChange: () => void
  t: (key: string) => string
}

export function ReadLaterShelf({
  books, language, loading, unreadOnly, onToggleUnread, onChange, t,
}: Props) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const handleMarkRead = async (id: string) => {
    setBusyId(id)
    try {
      await markUserBookRead(id)
      emitDataChanges(['user-books', 'shelves'])
      onChange()
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (book: UserBook) => {
    if (!window.confirm(`${t('library.readLater.deleteConfirm')}\n\n${book.title}`)) return
    setBusyId(book.id)
    try {
      await deleteUserBook(book.id)
      emitDataChanges(['user-books', 'shelves'])
      onChange()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="read-later">
      <div className="read-later__toolbar">
        <button
          type="button"
          className={`read-later__filter${unreadOnly ? ' read-later__filter--active' : ''}`}
          onClick={onToggleUnread}
          aria-pressed={unreadOnly}
        >
          <span className="material-icons-outlined">filter_list</span>
          {t('library.readLater.unread')}
        </button>
      </div>

      {loading && books.length === 0 ? (
        <div className="library-page__loading">{t('library.loading')}</div>
      ) : books.length === 0 ? (
        <div className="read-later__empty">
          <div className="empty-state__icon">🔖</div>
          <p className="empty-state__title">{t('library.readLater.empty')}</p>
        </div>
      ) : (
        <div className="read-later__list">
          {books.map((book) => (
            <ReadLaterCard
              key={book.id}
              book={book}
              language={language}
              busy={busyId === book.id}
              onMarkRead={() => handleMarkRead(book.id)}
              onDelete={() => handleDelete(book)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface CardProps {
  book: UserBook
  language: string
  busy: boolean
  onMarkRead: () => void
  onDelete: () => void
  t: (key: string) => string
}

function ReadLaterCard({ book, language, busy, onMarkRead, onDelete, t }: CardProps) {
  const state = cardState(book)
  const isReady = book.status === 'Ready'
  const domain = sourceDomain(book.sourceUrl)
  const coverUrl = getUserBookCoverUrl(book.coverPath)
  const destination = isReady
    ? (book.progressChapterSlug
        ? `/${language}/library/my/${book.id}/read/${book.progressChapterSlug}`
        : `/${language}/library/my/${book.id}`)
    : '#'
  const metaParts: string[] = []
  if (domain) metaParts.push(domain)
  metaParts.push(`${estReadMinutes(book.totalWordCount)} ${t('library.readLater.min')}`)
  metaParts.push(formatTimeAgo(book.createdAt))

  const Thumb = (
    <div className={`read-later__thumb${state.kind === 'processing' ? ' read-later__thumb--processing' : ''}`}>
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          onError={(e) => {
            e.currentTarget.style.display = 'none'
            e.currentTarget.nextElementSibling?.classList.remove('hidden')
          }}
        />
      ) : null}
      <span className={`material-icons-outlined read-later__thumb-icon ${coverUrl ? 'hidden' : ''}`}>
        {state.kind === 'processing' ? 'sync' : 'description'}
      </span>
    </div>
  )

  return (
    <article className={`read-later__item${isReady ? '' : ' read-later__item--disabled'}`} data-book-id={book.id}>
      {isReady ? (
        <Link to={destination} className="read-later__thumb-link" aria-label={book.title}>{Thumb}</Link>
      ) : Thumb}

      <div className="read-later__body">
        {/* SECURITY: title is untrusted (clipped from arbitrary pages) — render
            as React text only, never dangerouslySetInnerHTML. */}
        {isReady ? (
          <Link to={destination} className="read-later__title" title={book.title}>{book.title}</Link>
        ) : (
          <span className="read-later__title">{book.title}</span>
        )}

        {state.kind === 'processing' ? (
          <p className="read-later__meta">{t('library.readLater.processing')}</p>
        ) : (
          <p className="read-later__meta">
            {isHttpUrl(book.sourceUrl) && (
              <a
                href={book.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="read-later__source-link"
                title={t('library.readLater.openOriginal')}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="material-icons-outlined">open_in_new</span>
              </a>
            )}
            {/* domain is derived from untrusted sourceUrl — text only. */}
            <span>{metaParts.join(' · ')}</span>
          </p>
        )}

        {state.kind === 'inProgress' && (
          <div className="read-later__bar">
            <div className="read-later__bar-fill" style={{ width: `${state.percent}%` }} />
          </div>
        )}
      </div>

      <div className="read-later__right">
        {state.kind === 'processing' && (
          <span className="read-later__badge read-later__badge--processing">{t('library.badge.processing')}</span>
        )}
        {state.kind === 'failed' && (
          <span className="read-later__badge read-later__badge--failed">{t('library.failed')}</span>
        )}
        {state.kind === 'read' && (
          <span className="read-later__badge read-later__badge--read">{t('library.badge.finished')}</span>
        )}
        {state.kind === 'inProgress' && (
          <span className="read-later__pct">{state.percent}%</span>
        )}
        {state.kind === 'new' && (
          <span className="read-later__badge read-later__badge--new">{t('library.badge.new')}</span>
        )}

        <div className="read-later__actions">
          {isReady && !book.isRead && (
            <button
              type="button"
              className="read-later__action"
              onClick={onMarkRead}
              disabled={busy}
              title={t('library.readLater.markRead')}
              aria-label={t('library.readLater.markRead')}
            >
              <span className="material-icons-outlined">check_circle</span>
            </button>
          )}
          <button
            type="button"
            className="read-later__action read-later__action--danger"
            onClick={onDelete}
            disabled={busy}
            title={t('library.readLater.delete')}
            aria-label={t('library.readLater.delete')}
          >
            <span className="material-icons-outlined">delete_outline</span>
          </button>
        </div>
      </div>
    </article>
  )
}
