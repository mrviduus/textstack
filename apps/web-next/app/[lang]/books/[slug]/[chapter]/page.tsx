import { notFound } from 'next/navigation'
import { Metadata } from 'next'
import { getSsgBooks, getSsgChapters, getChapter, getBook } from '@/lib/api'
import { ReaderWrapper } from '@/components/reader/ReaderWrapper'

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
    <ReaderWrapper
      lang={lang}
      bookSlug={slug}
      bookTitle={book.title}
      chapterTitle={chapter.title}
      chapterHtml={chapter.html}
      prevChapter={chapter.prev}
      nextChapter={chapter.next}
      translations={t}
    />
  )
}

const translations: Record<string, { prevChapter: string; nextChapter: string; toc: string }> = {
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
