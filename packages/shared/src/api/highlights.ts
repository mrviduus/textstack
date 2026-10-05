import { authFetch, buildQuery, jsonBody } from './client'

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
  /** The stored {prefix, exact, suffix} anchor — the source of the surrounding text these
   *  screens show. Present since the list projection stopped dropping it. */
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

export async function getHighlights(editionId: string): Promise<PublicHighlight[]> {
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
  return authFetch<HighlightListResponse>(
    `/me/highlights/all${buildQuery({ limit: params?.limit, offset: params?.offset, bookType: params?.bookType, sort: params?.sort, search: params?.search, color: params?.color })}`
  )
}

export async function getHighlightsForReview(limit = 10): Promise<HighlightReviewItem[]> {
  return authFetch<HighlightReviewItem[]>(`/me/highlights/review?limit=${limit}`)
}

export async function markHighlightReviewed(highlightId: string): Promise<void> {
  await authFetch<void>('/me/highlights/review', jsonBody('POST', { highlightId }))
}

export async function createHighlight(data: {
  editionId?: string
  chapterId?: string
  userBookId?: string
  userChapterId?: string
  anchorJson: string
  color: string
  selectedText: string
  noteText?: string
}): Promise<PublicHighlight> {
  return authFetch<PublicHighlight>('/me/highlights', jsonBody('POST', data))
}

export interface UpdateHighlightData {
  color?: string
  anchorJson?: string
  selectedText?: string
  /** `undefined` leaves the note alone; `null` or blank removes it. */
  noteText?: string | null
  version?: number
}

/**
 * The PUT body. The server reads a null `noteText` as "unchanged" and clears a note only on
 * `removeNote`, so a cleared note (null or blank) is sent as that.
 */
export function updateHighlightBody(data: UpdateHighlightData) {
  const { noteText, ...rest } = data
  if (noteText === undefined) return rest
  if (noteText === null || noteText.trim() === '') return { ...rest, removeNote: true }
  return { ...rest, noteText }
}

export async function updateHighlight(id: string, data: UpdateHighlightData): Promise<PublicHighlight> {
  return authFetch<PublicHighlight>(`/me/highlights/${id}`, jsonBody('PUT', updateHighlightBody(data)))
}

export async function deleteHighlight(id: string): Promise<void> {
  await authFetch<void>(`/me/highlights/${id}`, { method: 'DELETE' })
}
