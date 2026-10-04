import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { StoredHighlight } from '../lib/offlineDb'

// Mock the persistence + network layers so the hook mounts without IndexedDB /
// fetch. Only the local load path is exercised (isAuthenticated omitted).
vi.mock('../lib/offlineDb', () => ({
  getHighlightsForEdition: vi.fn(),
  getHighlightsForUserBook: vi.fn(),
  saveHighlight: vi.fn(),
  deleteHighlight: vi.fn(),
}))
vi.mock('../api/userData', () => ({
  getPublicHighlights: vi.fn(),
  getUserBookHighlights: vi.fn(),
  createPublicHighlight: vi.fn(),
  updatePublicHighlight: vi.fn(),
  deletePublicHighlight: vi.fn(),
}))
vi.mock('../lib/dataEvents', () => ({ emitDataChange: vi.fn() }))

import { useHighlights } from './useHighlights'
import * as offlineDb from '../lib/offlineDb'
import * as userData from '../api/userData'

function pdfHighlight(): StoredHighlight {
  return {
    id: 'pdf-1',
    editionId: 'ed-1',
    chapterId: '',
    anchor: { v: 1, kind: 'pdf', page: 2, rects: [{ x: 10, y: 20, w: 30, h: 8 }], exact: 'painted' },
    color: 'yellow',
    selectedText: 'painted',
    syncStatus: 'synced',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function reflowHighlight(startOffset: number, endOffset: number): StoredHighlight {
  return {
    id: 'reflow-1',
    editionId: 'ed-1',
    chapterId: 'ch-1',
    anchor: { prefix: 'a', exact: 'b', suffix: 'c', startOffset, endOffset, chapterId: 'ch-1' },
    color: 'green',
    selectedText: 'b',
    syncStatus: 'synced',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('useHighlights.getHighlightsForRange', () => {
  beforeEach(() => vi.clearAllMocks())

  it('excludes PDF-anchored highlights from a reflow range query (M1)', async () => {
    vi.mocked(offlineDb.getHighlightsForEdition).mockResolvedValue([
      pdfHighlight(),
      reflowHighlight(10, 20),
    ])
    const { result } = renderHook(() => useHighlights('ed-1'))
    await waitFor(() => expect(result.current.highlights).toHaveLength(2))

    // The range overlaps the reflow highlight's [10,20). The PDF highlight has no
    // text offsets and must never surface, even though it would otherwise crash
    // on `h.anchor.startOffset`.
    const inRange = result.current.getHighlightsForRange(0, 100)
    expect(inRange).toHaveLength(1)
    expect(inRange[0].id).toBe('reflow-1')
  })

  it('still returns overlapping reflow highlights', async () => {
    vi.mocked(offlineDb.getHighlightsForEdition).mockResolvedValue([reflowHighlight(10, 20)])
    const { result } = renderHook(() => useHighlights('ed-1'))
    await waitFor(() => expect(result.current.highlights).toHaveLength(1))

    expect(result.current.getHighlightsForRange(15, 25)).toHaveLength(1) // overlaps
    expect(result.current.getHighlightsForRange(50, 60)).toHaveLength(0) // no overlap
  })
})

describe('useHighlights offline replay', () => {
  beforeEach(() => vi.clearAllMocks())

  const serverRow = {
    id: '3f2b8c1e-1111-4a2b-9c3d-000000000001',
    editionId: 'ed-1',
    chapterId: 'ch-1',
    userBookId: null,
    userChapterId: null,
    anchorJson: JSON.stringify(reflowHighlight(10, 20).anchor),
    color: 'green',
    selectedText: 'b',
    noteText: null,
    version: 1,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
  }
  const pending = (): StoredHighlight => ({ ...reflowHighlight(10, 20), id: '1759581234567-abc12de', syncStatus: 'pending' })

  it('keeps a pending offline highlight after server load and POSTs it', async () => {
    vi.mocked(offlineDb.getHighlightsForEdition).mockResolvedValue([pending()])
    vi.mocked(userData.getPublicHighlights).mockResolvedValue([])
    vi.mocked(userData.createPublicHighlight).mockResolvedValue(serverRow)

    const { result } = renderHook(() => useHighlights('ed-1', undefined, { isAuthenticated: true }))

    await waitFor(() => expect(result.current.highlights.map((x) => x.id)).toEqual([serverRow.id]))
    expect(userData.createPublicHighlight).toHaveBeenCalledTimes(1)
    expect(offlineDb.saveHighlight).toHaveBeenCalledWith(expect.objectContaining({ id: serverRow.id, syncStatus: 'synced' }))
    expect(offlineDb.deleteHighlight).toHaveBeenCalledWith(pending().id)
  })

  it('a failed replay keeps the highlight pending and visible', async () => {
    vi.mocked(offlineDb.getHighlightsForEdition).mockResolvedValue([pending()])
    vi.mocked(userData.getPublicHighlights).mockResolvedValue([])
    vi.mocked(userData.createPublicHighlight).mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useHighlights('ed-1', undefined, { isAuthenticated: true }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(userData.createPublicHighlight).toHaveBeenCalledTimes(1)
    expect(result.current.highlights.map((x) => x.id)).toEqual([pending().id])
    expect(offlineDb.deleteHighlight).not.toHaveBeenCalled()
  })

  it('a delete that cannot reach the server leaves a tombstone, not a resurrection', async () => {
    vi.mocked(offlineDb.getHighlightsForEdition).mockResolvedValue([{ ...reflowHighlight(10, 20), id: serverRow.id }])
    vi.mocked(userData.getPublicHighlights).mockResolvedValue([serverRow])
    vi.mocked(userData.deletePublicHighlight).mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useHighlights('ed-1', undefined, { isAuthenticated: true }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.removeHighlight(serverRow.id))

    expect(result.current.highlights).toEqual([])
    expect(offlineDb.saveHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: serverRow.id, deleted: true, syncStatus: 'pending' })
    )
  })
})
