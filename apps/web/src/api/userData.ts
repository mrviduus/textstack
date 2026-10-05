import { highlightsApi, type UpdateHighlightData } from '@textstack/shared'
import { authFetch } from './client'

// Bookmark types
export interface PublicBookmark {
  id: string
  editionId: string
  chapterId: string
  locator: string
  title: string | null
  createdAt: string
}

// Bookmark API
export async function getPublicBookmarks(editionId: string): Promise<PublicBookmark[]> {
  return authFetch<PublicBookmark[]>(`/me/bookmarks/${editionId}`)
}

export async function createPublicBookmark(data: {
  editionId: string
  chapterId: string
  locator: string
  title?: string
}): Promise<PublicBookmark> {
  return authFetch<PublicBookmark>('/me/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deletePublicBookmark(id: string): Promise<void> {
  await authFetch<void>(`/me/bookmarks/${id}`, {
    method: 'DELETE',
  })
}

// Highlight types
export interface PublicHighlight {
  id: string
  editionId: string | null
  chapterId: string | null
  userBookId: string | null
  userChapterId: string | null
  anchorJson: string
  color: string
  selectedText: string
  noteText: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface HighlightListItem {
  id: string
  selectedText: string
  /** The stored {prefix, exact, suffix} anchor — the source of the surrounding text the highlight
   *  screens show. Present since the list projection stopped dropping it.
   *  Duplicated from packages/shared/src/api/highlights.ts, as this whole file is. */
  anchorJson: string
  color: string
  noteText: string | null
  createdAt: string
  editionId: string | null
  editionTitle: string | null
  editionSlug: string | null
  editionCoverPath: string | null
  userBookId: string | null
  userBookTitle: string | null
  userBookCoverPath: string | null
  chapterId: string | null
  userChapterId: string | null
  chapterTitle: string | null
  userChapterTitle: string | null
  chapterSlug: string | null
  userChapterSlug: string | null
}

export interface HighlightListResponse {
  items: HighlightListItem[]
  totalCount: number
}

export interface HighlightReviewItem {
  id: string
  selectedText: string
  /** @see HighlightListItem.anchorJson */
  anchorJson: string
  color: string
  noteText: string | null
  bookTitle: string | null
  chapterTitle: string | null
  lastReviewedAt: string | null
}

// Highlight API
export async function getPublicHighlights(editionId: string): Promise<PublicHighlight[]> {
  return authFetch<PublicHighlight[]>(`/me/highlights/${editionId}`)
}

export async function getUserBookHighlights(userBookId: string): Promise<PublicHighlight[]> {
  return authFetch<PublicHighlight[]>(`/me/highlights/userbook/${userBookId}`)
}

export async function getAllHighlights(params?: {
  limit?: number
  offset?: number
  bookType?: 'all' | 'edition' | 'userbook'
  sort?: 'newest' | 'oldest'
  search?: string
  color?: string
}): Promise<HighlightListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  if (params?.bookType) searchParams.set('bookType', params.bookType)
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.search) searchParams.set('search', params.search)
  if (params?.color) searchParams.set('color', params.color)
  const qs = searchParams.toString()
  return authFetch<HighlightListResponse>(`/me/highlights/all${qs ? `?${qs}` : ''}`)
}

export async function getHighlightsForReview(limit = 10): Promise<HighlightReviewItem[]> {
  return authFetch<HighlightReviewItem[]>(`/me/highlights/review?limit=${limit}`)
}

export async function markHighlightReviewed(highlightId: string): Promise<void> {
  await authFetch<void>('/me/highlights/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ highlightId }),
  })
}

export async function createPublicHighlight(data: {
  editionId?: string
  chapterId?: string
  userBookId?: string
  userChapterId?: string
  anchorJson: string
  color: string
  selectedText: string
  noteText?: string
}): Promise<PublicHighlight> {
  return authFetch<PublicHighlight>('/me/highlights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function updatePublicHighlight(id: string, data: UpdateHighlightData): Promise<PublicHighlight> {
  return authFetch<PublicHighlight>(`/me/highlights/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(highlightsApi.updateHighlightBody(data)),
  })
}

export async function deletePublicHighlight(id: string): Promise<void> {
  await authFetch<void>(`/me/highlights/${id}`, {
    method: 'DELETE',
  })
}
