// API client for SSG data fetching

const API_URL = process.env.API_URL || 'http://localhost:8080'
const SSG_API_KEY = process.env.SSG_API_KEY || ''

// Site header for multisite support
const SITE_HOST = process.env.SITE_HOST || 'general.localhost'

interface FetchOptions {
  lang?: string
}

async function fetchApi<T>(path: string, opts?: FetchOptions): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Host': SITE_HOST,
  }

  if (opts?.lang) {
    headers['Accept-Language'] = opts.lang
  }

  if (SSG_API_KEY) {
    headers['X-SSG-Key'] = SSG_API_KEY
  }

  const res = await fetch(`${API_URL}${path}`, { headers })

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }

  return res.json()
}

// SSG endpoints (bulk, no pagination)
export interface SsgBook {
  slug: string
  language: string
}

export interface SsgChapter {
  slug: string
  order: number
}

export interface SsgAuthor {
  slug: string
}

export interface SsgGenre {
  slug: string
}

export async function getSsgBooks(): Promise<SsgBook[]> {
  return fetchApi('/ssg/books')
}

export async function getSsgChapters(bookSlug: string): Promise<SsgChapter[]> {
  return fetchApi(`/ssg/chapters/${bookSlug}`)
}

export async function getSsgAuthors(): Promise<SsgAuthor[]> {
  return fetchApi('/ssg/authors')
}

export async function getSsgGenres(): Promise<SsgGenre[]> {
  return fetchApi('/ssg/genres')
}

// Public API endpoints (for page data)
export interface BookAuthor {
  id: string
  slug: string
  name: string
  role: string
}

export interface ChapterSummary {
  id: string
  chapterNumber: number
  slug: string
  title: string
  wordCount: number | null
}

export interface BookDetail {
  id: string
  slug: string
  title: string
  language: string
  description: string | null
  coverPath: string | null
  publishedAt: string | null
  chapters: ChapterSummary[]
  otherEditions: { slug: string; language: string; title: string }[]
  authors: BookAuthor[]
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

export interface Edition {
  id: string
  slug: string
  title: string
  language: string
  coverPath: string | null
}

export interface AuthorDetail {
  id: string
  slug: string
  name: string
  bio: string | null
  photoPath: string | null
  editions: Edition[]
}

export interface GenreDetail {
  id: string
  slug: string
  name: string
  description: string | null
  bookCount: number
  editions: Edition[]
}

export interface BooksResponse {
  total: number
  items: {
    id: string
    slug: string
    title: string
    language: string
    coverPath: string | null
    authors: BookAuthor[]
  }[]
}

export interface AuthorsResponse {
  total: number
  items: {
    id: string
    slug: string
    name: string
    photoPath: string | null
    bookCount: number
  }[]
}

export async function getBooks(lang: string, limit = 20): Promise<BooksResponse> {
  return fetchApi(`/books?limit=${limit}`, { lang })
}

export async function getBook(slug: string, lang: string): Promise<BookDetail> {
  return fetchApi(`/books/${slug}`, { lang })
}

export async function getChapter(bookSlug: string, chapterSlug: string, lang: string): Promise<Chapter> {
  return fetchApi(`/books/${bookSlug}/chapters/${chapterSlug}`, { lang })
}

export async function getAuthor(slug: string): Promise<AuthorDetail> {
  return fetchApi(`/authors/${slug}`)
}

export async function getGenre(slug: string): Promise<GenreDetail> {
  return fetchApi(`/genres/${slug}`)
}

export async function getAuthors(limit = 10): Promise<AuthorsResponse> {
  return fetchApi(`/authors?limit=${limit}&sort=recent`)
}

// Storage URL helper
const STORAGE_URL = process.env.STORAGE_URL || 'http://localhost:8080/storage'

export function getStorageUrl(path: string | null): string | undefined {
  if (!path) return undefined
  return `${STORAGE_URL}/${path}`
}
