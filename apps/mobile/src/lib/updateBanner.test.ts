import { describe, it, expect } from 'vitest'
import { updateBannerState, shouldAnnounceUpdate, restartStore } from './updateBanner'

const idle = {
  isDev: false,
  isDownloading: false,
  isUpdatePending: false,
  pathname: '/library',
  restarting: false,
}
const READER = '/reader/dracula/chapter-1'

describe('updateBannerState', () => {
  it('shows nothing when idle or in development', () => {
    expect(updateBannerState(idle)).toEqual({ kind: 'none' })
    expect(updateBannerState({ ...idle, isDev: true, isDownloading: true, restarting: true })).toEqual({ kind: 'none' })
  })

  it('shows download progress, clamped, or indeterminate', () => {
    expect(updateBannerState({ ...idle, isDownloading: true, downloadProgress: 0.4 }))
      .toEqual({ kind: 'downloading', progress: 0.4 })
    expect(updateBannerState({ ...idle, isDownloading: true, downloadProgress: 1.7 }))
      .toEqual({ kind: 'downloading', progress: 1 })
    expect(updateBannerState({ ...idle, isDownloading: true })).toEqual({ kind: 'downloading' })
    expect(updateBannerState({ ...idle, isDownloading: true, downloadProgress: NaN })).toEqual({ kind: 'downloading' })
  })

  it('keeps the download bar off the reading text', () => {
    expect(updateBannerState({ ...idle, isDownloading: true, pathname: READER })).toEqual({ kind: 'none' })
    expect(updateBannerState({ ...idle, isDownloading: true, pathname: '/my-books/read/12/ch-3' })).toEqual({ kind: 'none' })
  })

  it('tells the reader a pending update waits for them', () => {
    expect(updateBannerState({ ...idle, isUpdatePending: true, pathname: READER })).toEqual({ kind: 'ready-in-reader' })
    // Outside the reader a pending update is applied at once — restarting covers it.
    expect(updateBannerState({ ...idle, isUpdatePending: true })).toEqual({ kind: 'none' })
  })

  it('restarting wins over everything else', () => {
    expect(updateBannerState({ ...idle, restarting: true, isDownloading: true, isUpdatePending: true }))
      .toEqual({ kind: 'restarting' })
  })
})

describe('shouldAnnounceUpdate', () => {
  it('announces a new OTA bundle', () => {
    expect(shouldAnnounceUpdate('a', 'b', false, false)).toBe(true)
  })

  it('stays quiet on the same bundle, first run, embedded launch, no id, or dev', () => {
    expect(shouldAnnounceUpdate('a', 'a', false, false)).toBe(false)
    expect(shouldAnnounceUpdate(null, 'b', false, false)).toBe(false)
    expect(shouldAnnounceUpdate('a', 'b', true, false)).toBe(false)
    expect(shouldAnnounceUpdate('a', null, false, false)).toBe(false)
    expect(shouldAnnounceUpdate('a', 'b', false, true)).toBe(false)
  })
})

describe('restartStore', () => {
  it('notifies subscribers and unsubscribes', () => {
    let calls = 0
    const off = restartStore.subscribe(() => { calls++ })
    restartStore.set(true)
    expect(restartStore.get()).toBe(true)
    off()
    restartStore.set(false)
    expect(calls).toBe(1)
  })
})
