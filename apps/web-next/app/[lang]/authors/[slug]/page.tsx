import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Metadata } from 'next'
import { getSsgAuthors, getAuthor, getStorageUrl } from '@/lib/api'

interface Props {
  params: Promise<{ lang: string; slug: string }>
}

// Generate static params for all authors
export async function generateStaticParams() {
  try {
    const authors = await getSsgAuthors()
    // Generate for both languages
    const params: { lang: string; slug: string }[] = []
    for (const a of authors) {
      params.push({ lang: 'en', slug: a.slug })
      params.push({ lang: 'uk', slug: a.slug })
    }
    return params
  } catch {
    return []
  }
}

// Generate metadata for SEO
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, slug } = await params
  try {
    const author = await getAuthor(slug)
    const t = translations[lang] || translations.en
    const title = `${author.name} — ${t.booksBy}`
    const description = author.bio || `${t.readBooksBy} ${author.name}`
    return {
      title,
      description,
      openGraph: {
        title,
        description,
        images: author.photoPath ? [getStorageUrl(author.photoPath)!] : undefined,
        type: 'profile',
      },
    }
  } catch {
    return { title: 'Author not found' }
  }
}

export default async function AuthorDetailPage({ params }: Props) {
  const { lang, slug } = await params

  let author
  try {
    author = await getAuthor(slug)
  } catch {
    notFound()
  }

  const t = translations[lang] || translations.en

  return (
    <main className="author-detail">
      <div className="author-detail__header">
        <div className="author-detail__photo">
          {author.photoPath ? (
            <img src={getStorageUrl(author.photoPath)} alt={author.name} />
          ) : (
            <span className="author-detail__initials">{author.name?.[0] || '?'}</span>
          )}
        </div>
        <div className="author-detail__info">
          <h1 className="author-detail__name">{author.name}</h1>
          {author.bio && <p className="author-detail__bio">{author.bio}</p>}
          <p className="author-detail__count">
            {author.editions.length} {author.editions.length === 1 ? t.book : t.books}
          </p>
        </div>
      </div>

      <section>
        <h2>{t.booksTitle}</h2>
        {author.editions.length === 0 ? (
          <p>{t.noBooksYet}</p>
        ) : (
          <div className="books-grid">
            {author.editions.map((book) => (
              <Link
                key={book.id}
                href={`/${lang}/books/${book.slug}`}
                className="book-card"
              >
                <div
                  className="book-card__cover"
                  style={{ backgroundColor: book.coverPath ? undefined : '#e0e0e0' }}
                >
                  {book.coverPath ? (
                    <img src={getStorageUrl(book.coverPath)} alt={book.title} />
                  ) : (
                    <span className="book-card__cover-text">{book.title?.[0] || '?'}</span>
                  )}
                </div>
                <h3 className="book-card__title">{book.title}</h3>
              </Link>
            ))}
          </div>
        )}
      </section>

      <Link href={`/${lang}/authors`} className="back-link">
        {t.backToAuthors}
      </Link>
    </main>
  )
}

const translations: Record<string, Record<string, string>> = {
  en: {
    booksBy: 'books by author',
    readBooksBy: 'Read books by',
    booksTitle: 'Books',
    book: 'book',
    books: 'books',
    noBooksYet: 'No books available yet.',
    backToAuthors: 'Back to Authors',
  },
  uk: {
    booksBy: 'книги автора',
    readBooksBy: 'Читайте книги автора',
    booksTitle: 'Книги',
    book: 'книга',
    books: 'книг',
    noBooksYet: 'Книг поки немає.',
    backToAuthors: 'До авторів',
  },
}
