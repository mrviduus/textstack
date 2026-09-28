import { describe, it, expect } from 'vitest'
import { chooseAutoDownloads, mayAutoDownload, type AutoDownloadCandidate } from './autoDownloadPolicy'

const book = (over: Partial<AutoDownloadCandidate> & { id: string }): AutoDownloadCandidate => ({
  status: 'Ready',
  progressUpdatedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
})

describe('chooseAutoDownloads', () => {
  it('puts the book you were in the middle of first', () => {
    const chosen = chooseAutoDownloads([
      book({ id: 'old-read', progressUpdatedAt: '2026-05-01T00:00:00Z' }),
      book({ id: 'never-read' }),
      book({ id: 'just-read', progressUpdatedAt: '2026-09-27T00:00:00Z' }),
    ], new Set())
    expect(chosen).toEqual(['just-read', 'old-read', 'never-read'])
  })

  it('orders books never opened by newest upload', () => {
    const chosen = chooseAutoDownloads([
      book({ id: 'ancient', createdAt: '2024-01-01T00:00:00Z' }),
      book({ id: 'fresh', createdAt: '2026-09-01T00:00:00Z' }),
      book({ id: 'middling', createdAt: '2025-06-01T00:00:00Z' }),
    ], new Set())
    // Starting a twenty-book library with the one abandoned two years ago is
    // the failure this ordering exists to avoid.
    expect(chosen).toEqual(['fresh', 'middling', 'ancient'])
  })

  it('skips what is already on the device', () => {
    const chosen = chooseAutoDownloads(
      [book({ id: 'a' }), book({ id: 'b' })],
      new Set(['a']),
    )
    expect(chosen).toEqual(['b'])
  })

  it('skips books with nothing to fetch yet', () => {
    const chosen = chooseAutoDownloads([
      book({ id: 'processing', status: 'Processing' }),
      book({ id: 'failed', status: 'Failed' }),
      book({ id: 'indexing', status: 'Indexing' }),
      book({ id: 'ready' }),
    ], new Set())
    expect(chosen).toEqual(['ready'])
  })

  it('survives a missing or unparseable timestamp instead of reordering wildly', () => {
    const chosen = chooseAutoDownloads([
      book({ id: 'broken', progressUpdatedAt: 'not-a-date' }),
      book({ id: 'read', progressUpdatedAt: '2026-09-01T00:00:00Z' }),
    ], new Set())
    expect(chosen).toEqual(['read', 'broken'])
  })

  it('returns nothing when there is nothing to do', () => {
    expect(chooseAutoDownloads([], new Set())).toEqual([])
    expect(chooseAutoDownloads([book({ id: 'a' })], new Set(['a']))).toEqual([])
  })
})

describe('mayAutoDownload', () => {
  const base = { connectionType: 'wifi', hasSession: true, usedBytes: 0, budgetBytes: 100 }

  it('runs on wifi, with a session, inside the budget', () => {
    expect(mayAutoDownload(base)).toBe(true)
  })

  it('never spends mobile data on its own', () => {
    expect(mayAutoDownload({ ...base, connectionType: 'cellular' })).toBe(false)
    // A library of 80 MB uploads over a metered link is a bill nobody agreed to.
    expect(mayAutoDownload({ ...base, connectionType: 'other' })).toBe(false)
  })

  it('waits rather than guesses while the connection type is unknown', () => {
    expect(mayAutoDownload({ ...base, connectionType: null })).toBe(false)
  })

  it('does nothing without a session — there is no library to fetch', () => {
    expect(mayAutoDownload({ ...base, hasSession: false })).toBe(false)
  })

  it('stops at the budget instead of evicting to make room', () => {
    expect(mayAutoDownload({ ...base, usedBytes: 100 })).toBe(false)
    expect(mayAutoDownload({ ...base, usedBytes: 101 })).toBe(false)
    expect(mayAutoDownload({ ...base, usedBytes: 99 })).toBe(true)
  })
})
