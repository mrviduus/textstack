import { describe, it, expect } from 'vitest'
import { downloadPercent, offlineStateFor } from './offlineState'

describe('offlineStateFor', () => {
  it('says in-cloud when the device has nothing', () => {
    expect(offlineStateFor({})).toBe('in-cloud')
    expect(offlineStateFor({ cached: null, download: null })).toBe('in-cloud')
    expect(offlineStateFor({ cached: { cachedChapters: 0, totalChapters: 12 } })).toBe('in-cloud')
  })

  it('says on-device only when every chapter is there', () => {
    expect(offlineStateFor({ cached: { cachedChapters: 12, totalChapters: 12 } })).toBe('on-device')
    expect(offlineStateFor({ cached: { cachedChapters: 11, totalChapters: 12 } })).toBe('partial')
  })

  it('does not call a PDF complete while its original is missing', () => {
    // Chapters alone are the text, not the book: offline it would open with the
    // figures stripped, which is the substitution the reader was told had gone.
    expect(offlineStateFor({
      cached: { cachedChapters: 12, totalChapters: 12 },
      needsOriginal: true,
      hasOriginal: false,
    })).toBe('partial')

    expect(offlineStateFor({
      cached: { cachedChapters: 12, totalChapters: 12 },
      needsOriginal: true,
      hasOriginal: true,
    })).toBe('on-device')
  })

  it('lets a running download speak over anything cached', () => {
    expect(offlineStateFor({
      download: { status: 'downloading', downloadedChapters: 3, totalChapters: 12 },
      cached: { cachedChapters: 3, totalChapters: 12 },
    })).toBe('downloading')

    // Including over a book that is already complete — a re-download is still
    // the most recent truth about what is happening.
    expect(offlineStateFor({
      download: { status: 'downloading', downloadedChapters: 1, totalChapters: 12 },
      cached: { cachedChapters: 12, totalChapters: 12 },
    })).toBe('downloading')
  })

  it('treats a stopped download as unfinished, not as absent', () => {
    // "In the cloud" about a half-downloaded book is a lie the next flight
    // would expose.
    expect(offlineStateFor({
      download: { status: 'error', downloadedChapters: 5, totalChapters: 12 },
      cached: { cachedChapters: 5, totalChapters: 12 },
    })).toBe('partial')

    expect(offlineStateFor({
      download: { status: 'cancelled', downloadedChapters: 2, totalChapters: 12 },
      cached: { cachedChapters: 2, totalChapters: 12 },
    })).toBe('partial')
  })

  it('does not call an empty book complete', () => {
    // 0 >= 0 is true, and a Ready book with no chapters would otherwise read as
    // fully downloaded forever.
    expect(offlineStateFor({ cached: { cachedChapters: 0, totalChapters: 0 } })).toBe('in-cloud')
  })
})

describe('downloadPercent', () => {
  it('reports progress a bar can use', () => {
    expect(downloadPercent({ downloadedChapters: 3, totalChapters: 12 })).toBe(25)
    expect(downloadPercent({ downloadedChapters: 12, totalChapters: 12 })).toBe(100)
    expect(downloadPercent({ downloadedChapters: 0, totalChapters: 12 })).toBe(0)
  })

  it('says nothing rather than dividing by zero', () => {
    expect(downloadPercent(null)).toBeNull()
    expect(downloadPercent(undefined)).toBeNull()
    expect(downloadPercent({ downloadedChapters: 1, totalChapters: 0 })).toBeNull()
  })

  it('never reports outside the bar', () => {
    expect(downloadPercent({ downloadedChapters: 20, totalChapters: 12 })).toBe(100)
    expect(downloadPercent({ downloadedChapters: -3, totalChapters: 12 })).toBe(0)
  })
})
