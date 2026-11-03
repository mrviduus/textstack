import { vi } from 'vitest'

/** One answer of the fake API: a status and a JSON body. */
export type Answer = { status: number; body?: unknown }
export interface Call { method: string; path: string; body: any }

/**
 * A fake V2 API behind `fetch`, for both clients' tests: each `METHOD /path` (no query, `base`
 * stripped) answers its list in turn, the last one repeating; an unrouted request answers 599.
 * Returns every request made, in order.
 */
export function fakeApi(routes: Record<string, Answer[]>, base = 'http://localhost:8080'): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = url.replace(base, '').split('?')[0]
    calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    const queue = routes[`${method} ${path}`]
    if (!queue) return { ok: false, status: 599, text: async () => `unexpected ${method} ${path}` }
    const a = queue.length > 1 ? queue.shift()! : queue[0]
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
  }))
  return calls
}

/** The probe answering V2 on. */
export const V2_ON = { 'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 1024 } }] }

export const file = (id: string, extra: object = {}) =>
  ({ id, sha256: 'x', byteSize: 3, originalName: 'b.epub', format: 'epub', hasContent: true, ...extra })

export const book = (id: string, fileId: string, extra: object = {}) =>
  ({ id, title: 'T', tags: [], hasCover: false, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', removedAt: null, currentFile: file(fileId), ...extra })

export const feed = (...items: unknown[]): Answer[] => [{ status: 200, body: { items, cursor: null, hasMore: false } }]

export const conflict = (code: string, extra: object = {}, status = 409): Answer => ({ status, body: { code, message: code, ...extra } })

export const card = (id: string, extra: object = {}) => ({
  id, language: 'en', word: 'quiver', translation: null, definition: null, stage: 0, intervalDays: 0, consecutiveCorrect: 0,
  nextReviewAt: '2026-11-02T00:00:00Z', lastReviewedAt: null, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
  deletedAt: null, retiredAt: null, revision: 1, examples: [], ...extra,
})

export const position = { v: 1, chapterSlug: 'two', anchor: { prefix: 'a', exact: 'quote', suffix: 'b', startOffset: 3, endOffset: 8 }, charOffset: 3, chapterFraction: 0.4 }

export const state = (bookId: string, revision: number, extra: object = {}) => ({
  bookId, fileId: 'f1', currentLocator: { version: 1, scheme: 'textstack-position-v1', value: position }, bookFraction: 0.7,
  frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: '2026-11-02T00:00:00Z',
  updatedAt: '2026-11-02T00:00:01Z', revision, resetRevision: null, ...extra,
})
