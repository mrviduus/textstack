import { authFetch } from './client'
import type { HighlightListResponse } from '@textstack/shared'

export type { HighlightListItem, HighlightListResponse } from '@textstack/shared'

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
