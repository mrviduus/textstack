import { authFetch, jsonBody } from './client'
import type { UserBookDto, UserBookChapterDto, BookmarkDto } from '../types/api'

export function getUserBooks() {
  return authFetch<UserBookDto[]>('/me/books')
}

export interface UserBookDetailResponse {
  id: string
  title: string
  slug: string
  language: string
  author: string | null
  description: string | null
  coverPath: string | null
  genre: string | null
  publishedYear: number | null
  totalWordCount: number | null
  status: string
  errorMessage: string | null
  chapters: {
    id: string
    chapterNumber: number
    slug: string | null
    title: string
    wordCount: number | null
    /** 1-based PDF page where this chapter starts. Null for EPUBs / unknown. */
    sourceStartPage?: number | null
  }[]
  toc: { title: string; chapterNumber: number | null; children: any[] | null }[] | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** True when the original upload is a PDF that can be rendered in the opt-in
   *  "Original layout" view. Absent on older payloads → false. */
  hasOriginalPdf?: boolean
  /** LLM metadata enrichment lifecycle (genre/year/description generation).
   *  "NotStarted" | "Pending" | "Running" | "Completed" | "Failed".
   *  Absent on older payloads → treat as no enrichment in flight. */
  metadataEnrichmentStatus?: string
}

export function getUserBook(id: string) {
  return authFetch<UserBookDetailResponse>(`/me/books/${id}`)
}

export function getUserBookChapter(bookId: string, chapterSlug: string) {
  return authFetch<UserBookChapterDto>(`/me/books/${bookId}/chapters/${chapterSlug}`)
}

export function uploadUserBook(formData: FormData) {
  return authFetch<UserBookDto>('/me/books/upload', {
    method: 'POST',
    body: formData,
  })
}

export function deleteUserBook(id: string) {
  return authFetch<void>(`/me/books/${id}`, { method: 'DELETE' })
}

export function retryUserBook(id: string) {
  return authFetch<void>(`/me/books/${id}/retry`, { method: 'POST' })
}

export function getUserBookProgress(bookId: string) {
  return authFetch<{
    chapterSlug: string | null
    locator: string | null
    percent: number | null
    updatedAt: string | null
    /** Where the reader is in the TEXT, serialised. Prefer it over `locator`. */
    positionJson?: string | null
  }>(`/me/books/${bookId}/progress`)
}

// chapterSlug is nullable — a chapterless PDF read in Original layout (ADR-012)
// persists a `page:<N>` locator with `chapterSlug: null` into the SAME progress
// row the reflow reader writes (see buildPdfProgressPayload).
/**
 * The body type had drifted: it named neither `percentUnit` nor `locatorKind`, and
 * compiled only because every caller passes a builder's return value rather than
 * an object literal. A type that does not describe the request is a type that
 * cannot catch a missing field — which is exactly how the web client shipped
 * without `percentUnit` and stopped storing percentages at all.
 */
export function updateUserBookProgress(bookId: string, data: {
  chapterSlug: string | null
  locator?: string
  percent?: number
  percentUnit?: string
  locatorKind?: string
  updatedAt?: string
  /** Serialised TextPosition. Absent means absent: the server clears the stored
   *  one rather than leaving it beside a fresher pixel offset. */
  positionJson?: string
}) {
  return authFetch<void>(`/me/books/${bookId}/progress`, jsonBody('PUT', data))
}

export function getUserBookBookmarks(bookId: string) {
  return authFetch<BookmarkDto[]>(`/me/books/${bookId}/bookmarks`)
}

// chapterId is nullable — an Original-layout PDF page bookmark (ADR-012 S4c)
// anchors to a `page:<N>` locator with no chapter.
export function createUserBookBookmark(bookId: string, data: { chapterId: string | null; locator: string; title?: string }) {
  return authFetch<BookmarkDto>(`/me/books/${bookId}/bookmarks`, jsonBody('POST', data))
}

export function deleteUserBookBookmark(bookId: string, bookmarkId: string) {
  return authFetch<void>(`/me/books/${bookId}/bookmarks/${bookmarkId}`, { method: 'DELETE' })
}

export function getStorageQuota() {
  return authFetch<{ usedBytes: number; limitBytes: number }>('/me/books/quota')
}

export function markUserBookComplete(id: string) {
  return authFetch<void>(`/me/books/${id}/complete`, { method: 'POST' })
}

export function unmarkUserBookComplete(id: string) {
  return authFetch<void>(`/me/books/${id}/complete`, { method: 'DELETE' })
}

export function cancelUserBook(id: string) {
  return authFetch<void>(`/me/books/${id}/cancel`, { method: 'POST' })
}

/**
 * Absolute URL of the original uploaded PDF (Range-enabled) for the Original-layout
 * viewer. Platform-agnostic: takes `apiBase` explicitly because mobile has no cookies —
 * it injects the Bearer via pdf.js `httpHeaders`, while web uses the cookie-based
 * `getUserBookFileUrl` in `apps/web`. Returns `${apiBase}/me/books/${id}/file`.
 */
export function getUserBookFileUrl(id: string, apiBase: string): string {
  return `${apiBase}/me/books/${id}/file`
}
