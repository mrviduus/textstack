import Link from 'next/link'
import { getBooks, getAuthors, getStorageUrl } from '@/lib/api'

interface Props {
  params: Promise<{ lang: string }>
}

export default async function HomePage({ params }: Props) {
  const { lang } = await params

  // Fetch recent books and authors
  const [booksRes, authorsRes] = await Promise.all([
    getBooks(lang, 12).catch(() => ({ total: 0, items: [] })),
    getAuthors(8).catch(() => ({ total: 0, items: [] })),
  ])

  const t = translations[lang] || translations.en

  return (
    <main className="home-page">
      <section className="hero">
        <h1>{t.heroTitle}</h1>
        <p>{t.heroSubtitle}</p>
      </section>

      <section className="recent-books">
        <h2>{t.recentBooks}</h2>
        {booksRes.items.length === 0 ? (
          <p>{t.noBooksYet}</p>
        ) : (
          <div className="books-grid">
            {booksRes.items.map((book) => (
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
                <p className="book-card__author">
                  {book.authors.map((a) => a.name).join(', ') || t.unknownAuthor}
                </p>
              </Link>
            ))}
          </div>
        )}
        <Link href={`/${lang}/books`} className="view-all">
          {t.viewAllBooks}
        </Link>
      </section>

      <section className="recent-authors">
        <h2>{t.recentAuthors}</h2>
        {authorsRes.items.length === 0 ? (
          <p>{t.noAuthorsYet}</p>
        ) : (
          <div className="authors-grid">
            {authorsRes.items.map((author) => (
              <Link
                key={author.id}
                href={`/${lang}/authors/${author.slug}`}
                className="author-card"
              >
                <div className="author-card__photo">
                  {author.photoPath ? (
                    <img src={getStorageUrl(author.photoPath)} alt={author.name} />
                  ) : (
                    <span className="author-card__initials">{author.name?.[0] || '?'}</span>
                  )}
                </div>
                <h3 className="author-card__name">{author.name}</h3>
                <p className="author-card__count">
                  {author.bookCount} {author.bookCount === 1 ? t.book : t.books}
                </p>
              </Link>
            ))}
          </div>
        )}
        <Link href={`/${lang}/authors`} className="view-all">
          {t.viewAllAuthors}
        </Link>
      </section>
    </main>
  )
}

// Simple translations
const translations: Record<string, Record<string, string>> = {
  en: {
    heroTitle: 'TextStack',
    heroSubtitle: 'Free online book library',
    recentBooks: 'Recent Books',
    recentAuthors: 'Recent Authors',
    noBooksYet: 'No books available yet.',
    noAuthorsYet: 'No authors available yet.',
    viewAllBooks: 'View all books',
    viewAllAuthors: 'View all authors',
    unknownAuthor: 'Unknown author',
    book: 'book',
    books: 'books',
  },
  uk: {
    heroTitle: 'TextStack',
    heroSubtitle: 'Безкоштовна онлайн бібліотека',
    recentBooks: 'Нові книги',
    recentAuthors: 'Нові автори',
    noBooksYet: 'Книг поки немає.',
    noAuthorsYet: 'Авторів поки немає.',
    viewAllBooks: 'Всі книги',
    viewAllAuthors: 'Всі автори',
    unknownAuthor: 'Невідомий автор',
    book: 'книга',
    books: 'книг',
  },
}
