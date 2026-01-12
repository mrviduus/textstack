import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Metadata } from 'next'
import { getSsgBooks, getSsgChapters, getChapter, getBook } from '@/lib/api'

interface Props {
  params: Promise<{ lang: string; slug: string; chapter: string }>
}

// Generate static params for all chapters
export async function generateStaticParams() {
  try {
    const books = await getSsgBooks()
    const allParams: { lang: string; slug: string; chapter: string }[] = []

    for (const book of books) {
      try {
        const chapters = await getSsgChapters(book.slug)
        for (const ch of chapters) {
          allParams.push({
            lang: book.language,
            slug: book.slug,
            chapter: ch.slug,
          })
        }
      } catch {
        // Skip books with no chapters
      }
    }

    return allParams
  } catch {
    return []
  }
}

// Generate metadata for SEO
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, slug, chapter: chapterSlug } = await params
  try {
    const [chapter, book] = await Promise.all([
      getChapter(slug, chapterSlug, lang),
      getBook(slug, lang),
    ])
    const title = `${chapter.title} — ${book.title}`
    const description = `Read ${chapter.title} from ${book.title} online`
    return {
      title,
      description,
      openGraph: { title, description },
    }
  } catch {
    return { title: 'Chapter not found' }
  }
}

export default async function ReaderPage({ params }: Props) {
  const { lang, slug, chapter: chapterSlug } = await params

  let chapter, book
  try {
    ;[chapter, book] = await Promise.all([
      getChapter(slug, chapterSlug, lang),
      getBook(slug, lang),
    ])
  } catch {
    notFound()
  }

  const t = translations[lang] || translations.en

  return (
    <main className="reader-page">
      <header className="reader-header">
        <Link href={`/${lang}/books/${slug}`} className="reader-header__back">
          {book.title}
        </Link>
        <h1 className="reader-header__title">{chapter.title}</h1>
      </header>

      <nav className="reader-nav reader-nav--top">
        {chapter.prev ? (
          <Link href={`/${lang}/books/${slug}/${chapter.prev.slug}`} className="reader-nav__link">
            ← {chapter.prev.title}
          </Link>
        ) : (
          <span />
        )}
        {chapter.next ? (
          <Link href={`/${lang}/books/${slug}/${chapter.next.slug}`} className="reader-nav__link">
            {chapter.next.title} →
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <article
        className="reader-content"
        dangerouslySetInnerHTML={{ __html: chapter.html }}
      />

      <nav className="reader-nav reader-nav--bottom">
        {chapter.prev ? (
          <Link href={`/${lang}/books/${slug}/${chapter.prev.slug}`} className="reader-nav__btn">
            ← {t.prevChapter}
          </Link>
        ) : (
          <span />
        )}
        <Link href={`/${lang}/books/${slug}`} className="reader-nav__btn reader-nav__btn--toc">
          {t.toc}
        </Link>
        {chapter.next ? (
          <Link href={`/${lang}/books/${slug}/${chapter.next.slug}`} className="reader-nav__btn">
            {t.nextChapter} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </main>
  )
}

const translations: Record<string, Record<string, string>> = {
  en: {
    prevChapter: 'Previous',
    nextChapter: 'Next',
    toc: 'Contents',
  },
  uk: {
    prevChapter: 'Попередній',
    nextChapter: 'Наступний',
    toc: 'Зміст',
  },
}
