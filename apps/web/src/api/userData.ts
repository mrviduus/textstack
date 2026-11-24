import { authFetch } from './client'

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
  /** Set only when the book was deleted: the title it had (#982). */
  deletedBookTitle: string | null
  /** The cover's version (the library's `updatedAt`) when the book has one: `syncApi.coverUrl(userBookId, it)` (#1580). */
  userBookCoverVersion?: string | null
}

export interface HighlightListResponse {
  items: HighlightListItem[]
  totalCount: number
}

// Highlight API
export async function getAllHighlights(params?: {
  limit?: number
  offset?: number
  sort?: 'newest' | 'oldest'
  search?: string
  color?: string
}): Promise<HighlightListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.search) searchParams.set('search', params.search)
  if (params?.color) searchParams.set('color', params.color)
  const qs = searchParams.toString()
  return authFetch<HighlightListResponse>(`/me/highlights/all${qs ? `?${qs}` : ''}`)
}
