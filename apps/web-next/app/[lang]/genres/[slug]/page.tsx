import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Metadata } from 'next'
import { getSsgGenres, getGenre, getStorageUrl } from '@/lib/api'

interface Props {
  params: Promise<{ lang: string; slug: string }>
}

// Generate static params for all genres
export async function generateStaticParams() {
  try {
    const genres = await getSsgGenres()
    // Generate for both languages
    const params: { lang: string; slug: string }[] = []
    for (const g of genres) {
      params.push({ lang: 'en', slug: g.slug })
      params.push({ lang: 'uk', slug: g.slug })
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
    const genre = await getGenre(slug)
    const t = translations[lang] || translations.en
    const title = `${genre.name} — ${t.booksOnline}`
    const description = genre.description || `${t.readBooks} ${genre.name}`
    return {
      title,
      description,
      openGraph: { title, description },
    }
  } catch {
    return { title: 'Genre not found' }
  }
}

export default async function GenreDetailPage({ params }: Props) {
  const { lang, slug } = await params

  let genre
  try {
    genre = await getGenre(slug)
  } catch {
    notFound()
  }

  const t = translations[lang] || translations.en

  return (
    <main className="genre-detail">
      <div className="genre-detail__header">
        <h1 className="genre-detail__name">{genre.name}</h1>
        {genre.description && <p className="genre-detail__description">{genre.description}</p>}
        <p className="genre-detail__count">
          {genre.bookCount} {genre.bookCount === 1 ? t.book : t.books}
        </p>
      </div>

      <section>
        <h2>{t.booksTitle}</h2>
        {genre.editions.length === 0 ? (
          <p>{t.noBooksYet}</p>
        ) : (
          <div className="books-grid">
            {genre.editions.map((book) => (
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

      <Link href={`/${lang}/genres`} className="back-link">
        {t.backToGenres}
      </Link>
    </main>
  )
}

const translations: Record<string, Record<string, string>> = {
  en: {
    booksOnline: 'books online',
    readBooks: 'Read books in',
    booksTitle: 'Books',
    book: 'book',
    books: 'books',
    noBooksYet: 'No books available yet.',
    backToGenres: 'Back to Genres',
  },
  uk: {
    booksOnline: 'книги онлайн',
    readBooks: 'Читайте книги жанру',
    booksTitle: 'Книги',
    book: 'книга',
    books: 'книг',
    noBooksYet: 'Книг поки немає.',
    backToGenres: 'До жанрів',
  },
}
