'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useReaderSettings, type ReaderSettings } from '@/hooks/useReaderSettings'
import { ReaderControls } from './ReaderControls'
import { ReaderSettingsDrawer } from './ReaderSettings'

interface ChapterNav {
  slug: string
  title: string
}

interface Props {
  lang: string
  bookSlug: string
  bookTitle: string
  chapterTitle: string
  chapterHtml: string
  prevChapter: ChapterNav | null
  nextChapter: ChapterNav | null
  translations: {
    prevChapter: string
    nextChapter: string
    toc: string
  }
}

function getFontFamily(family: ReaderSettings['fontFamily']): string {
  switch (family) {
    case 'serif': return 'Georgia, "Times New Roman", serif'
    case 'sans': return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    case 'dyslexic': return '"OpenDyslexic", sans-serif'
  }
}

export function ReaderWrapper({
  lang,
  bookSlug,
  bookTitle,
  chapterTitle,
  chapterHtml,
  prevChapter,
  nextChapter,
  translations: t,
}: Props) {
  const { settings, update, mounted } = useReaderSettings()
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Calculate simple progress (0 for now - could be enhanced with scroll tracking)
  const progress = 0

  return (
    <div className="reader-page" data-theme={settings.theme}>
      <ReaderControls
        lang={lang}
        bookSlug={bookSlug}
        bookTitle={bookTitle}
        chapterTitle={chapterTitle}
        progress={progress}
        onSettingsClick={() => setSettingsOpen(true)}
      />

      <nav className="reader-nav reader-nav--top">
        {prevChapter ? (
          <Link href={`/${lang}/books/${bookSlug}/${prevChapter.slug}`} className="reader-nav__link">
            ← {prevChapter.title}
          </Link>
        ) : (
          <span />
        )}
        {nextChapter ? (
          <Link href={`/${lang}/books/${bookSlug}/${nextChapter.slug}`} className="reader-nav__link">
            {nextChapter.title} →
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <article
        className="reader-content"
        style={mounted ? {
          fontSize: `${settings.fontSize}px`,
          lineHeight: settings.lineHeight,
          fontFamily: getFontFamily(settings.fontFamily),
          textAlign: settings.textAlign,
        } : undefined}
        dangerouslySetInnerHTML={{ __html: chapterHtml }}
      />

      <nav className="reader-nav reader-nav--bottom">
        {prevChapter ? (
          <Link href={`/${lang}/books/${bookSlug}/${prevChapter.slug}`} className="reader-nav__btn">
            ← {t.prevChapter}
          </Link>
        ) : (
          <span />
        )}
        <Link href={`/${lang}/books/${bookSlug}`} className="reader-nav__btn reader-nav__btn--toc">
          {t.toc}
        </Link>
        {nextChapter ? (
          <Link href={`/${lang}/books/${bookSlug}/${nextChapter.slug}`} className="reader-nav__btn">
            {t.nextChapter} →
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <ReaderSettingsDrawer
        open={settingsOpen}
        settings={settings}
        onUpdate={update}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
