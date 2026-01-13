import { LocalizedLink } from '../LocalizedLink'

interface Props {
  visible: boolean
  bookSlug: string
  title: string
  chapterTitle: string
  progress: number
  isBookmarked: boolean
  isAutoSaved?: boolean
  isFullscreen: boolean
  onSearchClick: () => void
  onTocClick: () => void
  onSettingsClick: () => void
  onBookmarkClick: () => void
  onFullscreenClick: () => void
  onHelpClick: () => void
}

export function ReaderTopBar({
  visible,
  bookSlug,
  title,
  chapterTitle,
  progress,
  isBookmarked,
  isAutoSaved,
  isFullscreen,
  onSearchClick,
  onTocClick,
  onSettingsClick,
  onBookmarkClick,
  onFullscreenClick,
  onHelpClick,
}: Props) {
  return (
    <header
      className="reader-top-bar"
      style={{
        transform: visible ? 'translateY(0)' : 'translateY(-100%)',
        opacity: visible ? 1 : 0,
      }}
    >
      <div className="reader-top-bar__left">
        <LocalizedLink to={`/books/${bookSlug}`} className="reader-top-bar__back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </LocalizedLink>
        <div className="reader-top-bar__title">
          <span className="reader-top-bar__book-title">{title}</span>
          <span className="reader-top-bar__chapter-title">{chapterTitle}</span>
        </div>
      </div>

      <div className="reader-top-bar__right">
        <span className="reader-top-bar__progress">{Math.round(progress * 100)}%</span>
        <button onClick={onSearchClick} className="reader-top-bar__btn" title="Search in chapter">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </button>
        <button onClick={onBookmarkClick} className="reader-top-bar__btn" title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill={isBookmarked || isAutoSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <button onClick={onTocClick} className="reader-top-bar__btn" title="Table of Contents">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <button onClick={onSettingsClick} className="reader-top-bar__btn" title="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16M4 12h16M4 18h16" />
            <circle cx="8" cy="6" r="2" fill="currentColor" />
            <circle cx="16" cy="12" r="2" fill="currentColor" />
            <circle cx="10" cy="18" r="2" fill="currentColor" />
          </svg>
        </button>
        <button onClick={onFullscreenClick} className="reader-top-bar__btn" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {isFullscreen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          )}
        </button>
        <button onClick={onHelpClick} className="reader-top-bar__btn reader-top-bar__btn--desktop-only" title="Keyboard shortcuts (?)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <path d="M12 17h.01" />
          </svg>
        </button>
      </div>
    </header>
  )
}
