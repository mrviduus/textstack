export interface BookAuthor {
  id: string
  slug: string
  name: string
  role: string
}

export interface Edition {
  id: string
  slug: string
  title: string
  language: string
  description: string | null
  coverPath: string | null
  publishedAt: string | null
  chapterCount: number
  authors: BookAuthor[]
}

export interface ChapterSummary {
  id: string
  chapterNumber: number
  slug: string
  title: string
  wordCount: number | null
}

export interface ChapterNav {
  slug: string
  title: string
}

export interface Chapter {
  id: string
  chapterNumber: number
  slug: string
  title: string
  html: string
  wordCount: number | null
  prev: ChapterNav | null
  next: ChapterNav | null
}

export interface BookGenre {
  id: string
  slug: string
  name: string
}

export interface RelatedBook {
  id: string
  slug: string
  title: string
  coverPath: string | null
}

export interface PodcastStatusDto {
  jobId: string
  status: 'Queued' | 'Running' | 'Succeeded' | 'Failed'
  audioUrl: string | null
  durationSeconds: number | null
}

export interface BookDetail {
  id: string
  slug: string
  title: string
  language: string
  description: string | null
  coverPath: string | null
  publishedAt: string | null
  isPublicDomain: boolean
  // Mirrors the DB column. When false, BookDetailPage emits noindex so
  // copyright-grey items still render for direct visitors but stay out of
  // search engines.
  indexable: boolean
  seoTitle: string | null
  seoDescription: string | null
  // SEO content blocks
  seoRelevanceText: string | null
  seoThemesJson: string | null
  seoFaqsJson: string | null
  chapters: ChapterSummary[]
  otherEditions: { slug: string; language: string; title: string }[]
  authors: BookAuthor[]
  genres: BookGenre[]
  moreByAuthor: RelatedBook[]
}

export interface SearchEdition {
  id: string
  slug: string
  title: string
  language: string
  authors: string | null
  coverPath: string | null
}

export interface SearchResult {
  chapterId: string
  chapterSlug: string | null
  chapterTitle: string | null
  chapterNumber: number
  edition: SearchEdition
  highlights: string[] | null
}

export interface Suggestion {
  text: string
  slug: string
  authors: string | null
  coverPath: string | null
  score: number
}

export interface Author {
  id: string
  slug: string
  name: string
  bio: string | null
  photoPath: string | null
  bookCount: number
}

export interface AuthorDetail extends Author {
  seoRelevanceText: string | null
  seoThemesJson: string | null
  seoFaqsJson: string | null
  externalLinksJson: string | null
  editions: Edition[]
}

export interface Genre {
  id: string
  slug: string
  name: string
  description: string | null
  bookCount: number
}

export interface GenreDetail extends Genre {
  editions: Edition[]
}
