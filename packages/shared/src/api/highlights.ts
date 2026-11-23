import { authFetch, buildQuery } from './client'

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
  /** Set only when the book was deleted: the title it had (#982). */
  deletedBookTitle: string | null
}

export interface HighlightListResponse {
  items: HighlightListItem[]
  totalCount: number
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
