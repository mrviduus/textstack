import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { deleteUserBook, retryUserBook, cancelUserBook, type UserBook } from '../../api/userBooks'
import { useLanguage } from '../../context/LanguageContext'

interface UserBookMenuProps {
  book: UserBook
  onAction: () => void
}

export function UserBookMenu({ book, onAction }: UserBookMenuProps) {
  const { language } = useLanguage()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const isReady = book.status === 'Ready'
  const isFailed = book.status === 'Failed'
  const isProcessing = book.status === 'Processing'

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      await deleteUserBook(book.id)
      onAction()
    } catch {}
    setDeleting(false)
    setOpen(false)
  }

  const handleRetry = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await retryUserBook(book.id)
      onAction()
    } catch {}
    setRetrying(false)
    setOpen(false)
  }

  const handleCancel = async () => {
    if (cancelling) return
    setCancelling(true)
    try {
      await cancelUserBook(book.id)
      onAction()
    } catch {}
    setCancelling(false)
    setOpen(false)
  }

  return (
    <div className="user-book-card__menu" ref={menuRef}>
      <button
        className="user-book-card__menu-trigger"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v) }}
        aria-haspopup="true"
        aria-expanded={open}
        title="Options"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      {open && (
        <div className="user-book-card__dropdown" role="menu">
          {isReady && (
            <Link
              to={`/${language}/library/my/${book.id}`}
              className="user-book-card__item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              View details
            </Link>
          )}
          {isFailed && (
            <button className="user-book-card__item" onClick={handleRetry} disabled={retrying} role="menuitem">
              {retrying ? 'Retrying...' : 'Retry'}
            </button>
          )}
          {isProcessing && (
            <button className="user-book-card__item user-book-card__item--danger" onClick={handleCancel} disabled={cancelling} role="menuitem">
              {cancelling ? 'Cancelling...' : 'Cancel'}
            </button>
          )}
          <button className="user-book-card__item user-book-card__item--danger" onClick={handleDelete} disabled={deleting} role="menuitem">
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  )
}
