// @vitest-environment jsdom
/**
 * R2 M9: chevrons, TOC, bookmarks and highlights open a chapter through `openChapter`, the
 * offline-aware path — through the real hook, with the network state and the device faked.
 * (ReaderShell's TOC handler calling it is a guard in readerR2Wiring.test.ts: the shell renders
 * native views.)
 */
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '../../test/renderHook'
import { useReaderChapterNav } from './useReaderChapterNav'

const net = vi.hoisted(() => ({ online: true }))
vi.mock('../../hooks/useOnline', () => ({ useOnline: () => net.online }))

const noop = () => {}
function mount(onDevice: (slug: string) => Promise<boolean>) {
  const io = {
    navigate: vi.fn(),
    ensureChapter: vi.fn(async () => {}),
    isChapterOnDevice: vi.fn(onDevice),
    toast: vi.fn(() => 1),
  }
  const h = renderHook(useReaderChapterNav, {
    chapter: { id: 'c1', title: 'One', html: '', prev: null, next: { slug: 'ch-2', title: 'Two' } },
    chapters: [], bookTitle: 'Book', saveProgress: noop, ensureChapter: io.ensureChapter,
    isChapterOnDevice: io.isChapterOnDevice, onNavigateChapter: io.navigate, chapterNavigatorRef: { current: null },
    original: false, injectJs: noop, visitKey: 'book', handOffSession: () => ({ snapshot: null, flush: noop }) as never,
    sessionWordCount: 0, sessionWordCountRef: { current: 0 }, finishedChapterRef: { current: false },
    aliveRef: { current: true }, showToast: io.toast as never, language: 'en', footerHeight: 0,
    discussBrief: null, discuss: noop, handleExitReview: noop, router: { dismissTo: noop } as never,
  } as never)
  const open = (slug: string) => act(async () => { await h.result.current.openChapter(slug) })
  return { io, open, h }
}

beforeEach(() => { net.online = true })

describe('M9 — opening a chapter never waits on a network', () => {
  it('online: navigates at once, without asking the device or fetching the chapter', async () => {
    const r = mount(() => new Promise(() => {}))
    await r.open('ch-5')
    expect(r.io.navigate).toHaveBeenCalledWith('ch-5')
    expect(r.io.isChapterOnDevice).not.toHaveBeenCalled()
    expect(r.io.ensureChapter).not.toHaveBeenCalled()
  })

  it('offline, chapter on the device: navigates (SQLite only, no fetch)', async () => {
    net.online = false
    const r = mount(async () => true)
    await r.open('ch-5')
    expect(r.io.navigate).toHaveBeenCalledWith('ch-5')
    expect(r.io.ensureChapter).not.toHaveBeenCalled()
  })

  it('offline, chapter not on the device: stays, says so, and a later tap can try again', async () => {
    net.online = false
    const r = mount(async () => false)
    await r.open('ch-5')
    expect(r.io.navigate).not.toHaveBeenCalled()
    expect(r.io.toast).toHaveBeenCalledTimes(1)
    await r.open('ch-5')
    expect(r.io.toast).toHaveBeenCalledTimes(2)
  })

  it('a tap burst navigates once', async () => {
    const r = mount(async () => true)
    await act(async () => { void r.h.result.current.openChapter('ch-5'); void r.h.result.current.openChapter('ch-6') })
    expect(r.io.navigate).toHaveBeenCalledTimes(1)
    expect(r.io.navigate).toHaveBeenCalledWith('ch-5')
  })
})
