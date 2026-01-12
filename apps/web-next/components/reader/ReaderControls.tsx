'use client'

import Link from 'next/link'

interface Props {
  lang: string
  bookSlug: string
  bookTitle: string
  chapterTitle: string
  progress: number
  onSettingsClick: () => void
}

export function ReaderControls({
  lang,
  bookSlug,
  bookTitle,
  chapterTitle,
  progress,
  onSettingsClick,
}: Props) {
  return (
    <header className="reader-top-bar">
      <div className="reader-top-bar__left">
        <Link href={`/${lang}/books/${bookSlug}`} className="reader-top-bar__back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </Link>
        <div className="reader-top-bar__title">
          <span className="reader-top-bar__book-title">{bookTitle}</span>
          <span className="reader-top-bar__chapter-title">{chapterTitle}</span>
        </div>
      </div>

      <div className="reader-top-bar__right">
        <span className="reader-top-bar__progress">{Math.round(progress * 100)}%</span>
        <button onClick={onSettingsClick} className="reader-top-bar__btn" title="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16M4 12h16M4 18h16" />
            <circle cx="8" cy="6" r="2" fill="currentColor" />
            <circle cx="16" cy="12" r="2" fill="currentColor" />
            <circle cx="10" cy="18" r="2" fill="currentColor" />
          </svg>
        </button>
      </div>
    </header>
  )
}
