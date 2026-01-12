import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Metadata } from 'next'
import { getSsgBooks, getBook, getStorageUrl } from '@/lib/api'

interface Props {
  params: Promise<{ lang: string; slug: string }>
}

// Generate static params for all books
export async function generateStaticParams() {
  try {
    const books = await getSsgBooks()
    return books.map((b) => ({ lang: b.language, slug: b.slug }))
  } catch {
    return []
  }
}

// Generate metadata for SEO
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, slug } = await params
  try {
    const book = await getBook(slug, lang)
    return {
      title: book.title,
      description: book.description || `Read ${book.title} online`,
      openGraph: {
        title: book.title,
        description: book.description || undefined,
        images: book.coverPath ? [getStorageUrl(book.coverPath)!] : undefined,
        type: 'book',
      },
    }
  } catch {
    return { title: 'Book not found' }
  }
}

export default async function BookDetailPage({ params }: Props) {
  const { lang, slug } = await params

  let book
  try {
    book = await getBook(slug, lang)
  } catch {
    notFound()
  }

  const t = translations[lang] || translations.en
  const firstChapter = book.chapters[0]

  return (
    <main className="book-detail">
      <div className="book-detail__header">
        <div
          className="book-detail__cover"
          style={{ backgroundColor: book.coverPath ? undefined : '#e0e0e0' }}
        >
          {book.coverPath ? (
            <img src={getStorageUrl(book.coverPath)} alt={book.title} />
          ) : (
            <span className="book-detail__cover-text">{book.title?.[0] || '?'}</span>
          )}
        </div>

        <div className="book-detail__info">
          <h1>{book.title}</h1>

          <p className="book-detail__author">
            {book.authors.length > 0
              ? book.authors.map((a, i) => (
                  <span key={a.id}>
                    {i > 0 && ', '}
                    <Link href={`/${lang}/authors/${a.slug}`}>{a.name}</Link>
                  </span>
                ))
              : t.unknownAuthor}
          </p>

          {book.description && (
            <p className="book-detail__description">{stripHtml(book.description)}</p>
          )}

          <p className="book-detail__meta">
            {book.chapters.length} {t.chapters} · {book.language.toUpperCase()}
          </p>

          {firstChapter && (
            <Link
              href={`/${lang}/books/${book.slug}/${firstChapter.slug}`}
              className="book-detail__read-btn"
            >
              {t.startReading}
            </Link>
          )}
        </div>
      </div>

      <section className="book-detail__toc">
        <h2>{t.chapters}</h2>
        <ul>
          {book.chapters.map((ch) => (
            <li key={ch.id}>
              <Link href={`/${lang}/books/${book.slug}/${ch.slug}`}>
                <span className="chapter-number">{ch.chapterNumber + 1}.</span>
                <span className="chapter-title">{ch.title}</span>
                {ch.wordCount && (
                  <span className="chapter-words">{ch.wordCount} {t.words}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {book.otherEditions.length > 0 && (
        <section className="book-detail__editions">
          <h2>{t.otherEditions}</h2>
          <ul>
            {book.otherEditions.map((ed) => (
              <li key={ed.slug}>
                <Link href={`/${ed.language}/books/${ed.slug}`}>
                  {ed.title} ({ed.language.toUpperCase()})
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href={`/${lang}/books`} className="book-detail__back">
        {t.backToBooks}
      </Link>
    </main>
  )
}

// Strip HTML tags
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

const translations: Record<string, Record<string, string>> = {
  en: {
    unknownAuthor: 'Unknown author',
    chapters: 'chapters',
    words: 'words',
    startReading: 'Start Reading',
    otherEditions: 'Other Editions',
    backToBooks: 'Back to Books',
  },
  uk: {
    unknownAuthor: 'Невідомий автор',
    chapters: 'розділів',
    words: 'слів',
    startReading: 'Почати читати',
    otherEditions: 'Інші видання',
    backToBooks: 'До книг',
  },
}
