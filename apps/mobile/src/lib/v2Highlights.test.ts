import { describe, it, expect, vi } from 'vitest'
import type { V2Annotation } from '@textstack/shared'
import { initApi } from '@textstack/shared'
import { toPublicHighlight, toV2Write, userBookHighlightsApi, HighlightDeletedError } from './v2Highlights'

vi.mock('./v2', () => ({ onV2: async () => true, v2Book: async () => ({ currentFile: { id: 'f1' } }), v2Annotations: { rows: new Map(), pulled: new Set() } }))

const row = (locator: V2Annotation['locator']): V2Annotation => ({
  id: 'h1', bookId: 'b1', fileId: 'f1', selectedText: 'hello there', noteText: null, locator, color: 'yellow',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', deletedAt: null, revision: 4,
})

describe('upload highlights on V2', () => {
  it('writes a reflow anchor as textstack-anchor-v1 with the chapter the reader is on', () => {
    const anchor = { prefix: 'p', exact: 'hello there', suffix: 's', startOffset: 3, endOffset: 14 }
    const write = toV2Write({ userBookId: 'b1', userChapterId: 'key-2', anchorJson: JSON.stringify(anchor), color: 'blue', selectedText: 'hello there' }, 'f1', null)
    expect(write).toMatchObject({
      expectedRevision: null, bookId: 'b1', fileId: 'f1', color: 'blue', noteText: null,
      locator: { version: 1, scheme: 'textstack-anchor-v1', value: { ...anchor, chapterKey: 'key-2' } },
    })
  })

  it('writes a PDF anchor as pdf-page, and a bare quote with no locator (and no file)', () => {
    const pdf = { v: 1, kind: 'pdf', page: 3, rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }], exact: 'x' }
    expect(toV2Write({ userBookId: 'b1', anchorJson: JSON.stringify(pdf), color: 'y', selectedText: 'x' }, 'f1', 2).locator)
      .toEqual({ version: 1, scheme: 'pdf-page', value: pdf })
    const bare = toV2Write({ userBookId: 'b1', userChapterId: 'k', anchorJson: JSON.stringify({ exact: 'x' }), color: 'y', selectedText: 'x' }, 'f1', null)
    expect(bare).toMatchObject({ locator: null, fileId: null })
  })

  it('reads a row back as the reader draws it: chapter key as the chapter, revision as the version', () => {
    const h = toPublicHighlight(row({ version: 1, scheme: 'textstack-anchor-v1', value: { chapterKey: 'key-2', prefix: 'p', exact: 'hello', suffix: 's', startOffset: 1, endOffset: 6 } }))
    expect(h).toMatchObject({ id: 'h1', userBookId: 'b1', userChapterId: 'key-2', version: 4 })
    expect(JSON.parse(h.anchorJson)).toMatchObject({ exact: 'hello', chapterId: 'key-2' })
    // The V2 reader's epub-cfi highlight is its quotation here (never converted).
    expect(JSON.parse(toPublicHighlight(row({ version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/2)' })).anchorJson)).toEqual({ exact: 'hello there' })
  })

  it('an edit lost to another device\'s delete is reported deleted, not drawn', async () => {
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
    const live = row({ version: 1, scheme: 'textstack-anchor-v1', value: { chapterKey: 'k', prefix: '', exact: 'hello', suffix: '', startOffset: 0, endOffset: 5 } })
    const answers = [
      { status: 200, body: { items: [live], cursor: 'c', hasMore: false } },
      { status: 409, body: { code: 'deleted', message: 'x', current: { ...live, deletedAt: '2026-11-02T00:00:00Z' } } },
    ]
    const fetchMock = vi.fn(async () => {
      const a = answers.shift()!
      return { ok: a.status < 300, status: a.status, text: async () => JSON.stringify(a.body) }
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await userBookHighlightsApi.getUserBookHighlights('b1')).toHaveLength(1)
    expect(await userBookHighlightsApi.getUserBookHighlights('b1')).toHaveLength(1) // from the store: one pull per open
    await expect(userBookHighlightsApi.updateHighlight('h1', { color: 'blue' })).rejects.toBeInstanceOf(HighlightDeletedError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })
})
