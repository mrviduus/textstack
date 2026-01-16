import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../../context/LanguageContext'
import { useDownload } from '../../context/DownloadContext'
import { getCachedBookMeta, deleteAllCachedData } from '../../lib/offlineDb'
import type { LibraryItem } from '../../api/auth'

interface BookCardMenuProps {
  book: LibraryItem
  isRead?: boolean
  onRemove: () => void
  onMarkRead?: () => void
  onMarkUnread?: () => void
}

export function BookCardMenu({
  book,
  isRead = false,
  onRemove,
  onMarkRead,
  onMarkUnread,
}: BookCardMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [isOffline, setIsOffline] = useState(false)
  const [isPartiallyOffline, setIsPartiallyOffline] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const longPressTimer = useRef<number | null>(null)

  const navigate = useNavigate()
  const { language } = useLanguage()
  const { startDownload, cancelDownload, isDownloading: checkDownloading, getProgress } = useDownload()
  const progress = getProgress(book.editionId)

  // Check offline status
  useEffect(() => {
    getCachedBookMeta(book.editionId).then(meta => {
      if (meta && meta.cachedChapters >= meta.totalChapters) {
        setIsOffline(true)
        setIsPartiallyOffline(false)
      } else if (meta && meta.cachedChapters > 0) {
        setIsOffline(false)
        setIsPartiallyOffline(true)
      } else {
        setIsOffline(false)
        setIsPartiallyOffline(false)
      }
    })
  }, [book.editionId])

  // Check if downloading
  useEffect(() => {
    setIsDownloading(checkDownloading(book.editionId))
  }, [book.editionId, checkDownloading, progress])

  // Close on click outside
  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
        setPosition(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // Close on escape
  useEffect(() => {
    if (!open) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setPosition(null)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open])

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPosition(null) // Use default position (below trigger)
    setOpen(prev => !prev)
  }

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPosition({ x: e.clientX, y: e.clientY })
    setOpen(true)
  }, [])

  const handleLongPressStart = useCallback((e: React.TouchEvent) => {
    longPressTimer.current = window.setTimeout(() => {
      const touch = e.touches[0]
      setPosition({ x: touch.clientX, y: touch.clientY })
      setOpen(true)
      // Vibrate on supported devices
      if (navigator.vibrate) navigator.vibrate(50)
    }, 500)
  }, [])

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const closeMenu = () => {
    setOpen(false)
    setPosition(null)
  }

  const handleViewDetails = () => {
    closeMenu()
    navigate(`/${language}/books/${book.slug}`)
  }

  const handleMarkRead = () => {
    closeMenu()
    if (isRead) {
      onMarkUnread?.()
    } else {
      onMarkRead?.()
    }
  }

  const handleDownload = () => {
    closeMenu()
    if (isDownloading) {
      cancelDownload(book.editionId)
    } else {
      // Start or resume download
      startDownload(book.editionId, book.slug, book.title, language)
    }
  }

  const handleRemoveDownload = () => {
    closeMenu()
    deleteAllCachedData(book.editionId).then(() => {
      setIsOffline(false)
      setIsPartiallyOffline(false)
    })
  }

  const handleRemove = () => {
    closeMenu()
    onRemove()
  }

  // Calculate menu position
  const getMenuStyle = (): React.CSSProperties => {
    if (position) {
      // Context menu / long press - position at cursor
      return {
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: 'none',
      }
    }
    // Default - below trigger button
    return {}
  }

  return (
    <div
      className="book-card-menu"
      onContextMenu={handleContextMenu}
      onTouchStart={handleLongPressStart}
      onTouchEnd={handleLongPressEnd}
      onTouchCancel={handleLongPressEnd}
    >
      <button
        ref={triggerRef}
        className="book-card-menu__trigger"
        onClick={handleTriggerClick}
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
        <div
          ref={menuRef}
          className="book-card-menu__dropdown"
          style={getMenuStyle()}
          role="menu"
        >
          <button
            className="book-card-menu__item"
            onClick={handleViewDetails}
            role="menuitem"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            View details
          </button>

          <button
            className="book-card-menu__item"
            onClick={handleMarkRead}
            role="menuitem"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isRead ? (
                <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              ) : (
                <polyline points="20 6 9 17 4 12" />
              )}
            </svg>
            {isRead ? 'Mark as unread' : 'Mark as read'}
          </button>

          {/* Download/Resume button - hide when fully offline */}
          {!isOffline && (
            <button
              className="book-card-menu__item"
              onClick={handleDownload}
              role="menuitem"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {isDownloading ? (
                  <path d="M18 6L6 18M6 6l12 12" />
                ) : (
                  <>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </>
                )}
              </svg>
              {isDownloading ? 'Cancel download' : isPartiallyOffline ? 'Resume download' : 'Download for offline'}
            </button>
          )}

          {/* Remove download button - show when offline or partial */}
          {(isOffline || isPartiallyOffline) && !isDownloading && (
            <button
              className="book-card-menu__item"
              onClick={handleRemoveDownload}
              role="menuitem"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Remove download
            </button>
          )}

          <div className="book-card-menu__divider" />

          <button
            className="book-card-menu__item book-card-menu__item--danger"
            onClick={handleRemove}
            role="menuitem"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Remove from library
          </button>
        </div>
      )}
    </div>
  )
}
