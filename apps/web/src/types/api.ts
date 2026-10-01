// Identical to the shared types — re-exported so existing imports keep working.
import type { Author, BookDetail as SharedBookDetail, Edition, Genre } from '@textstack/shared'
export type {
  BookAuthor, Edition, ChapterSummary, ChapterNav, Chapter,
  SearchEdition, SearchResult, Suggestion, Author, Genre,
} from '@textstack/shared'

export interface BookGenre {
  id: string
  slug: string
  name: string
}

export interface PodcastStatusDto {
  jobId: string
  status: 'Queued' | 'Running' | 'Succeeded' | 'Failed'
  audioUrl: string | null
  durationSeconds: number | null
}

// Web reads two fields mobile does not; the rest is the shared shape.
export interface BookDetail extends SharedBookDetail {
  // Mirrors the DB column. When false, BookDetailPage emits noindex so
  // copyright-grey items still render for direct visitors but stay out of
  // search engines.
  indexable: boolean
  genres: BookGenre[]
}

export interface AuthorDetail extends Author {
  seoRelevanceText: string | null
  seoThemesJson: string | null
  seoFaqsJson: string | null
  externalLinksJson: string | null
  editions: Edition[]
}

export interface GenreDetail extends Genre {
  editions: Edition[]
}
