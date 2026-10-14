import { vi } from 'vitest'
import type { EngineEvents, GoToResult, Locator, ReaderEngine } from '@textstack/reader-engine'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'

// Plumbing for the useReaderScrollSync tests: the page's scroll position and the engine the hook drives.

export function setScroll(top: number) {
  const el = (document.scrollingElement || document.documentElement) as HTMLElement
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true })
}
export function getScroll(): number {
  return ((document.scrollingElement || document.documentElement) as HTMLElement).scrollTop
}
/** The page scrolls without the engine moving it: the reader (wheel, scrollbar, Ctrl+F) or the browser. */
export function userScroll(top: number) {
  setScroll(top)
  window.dispatchEvent(new Event('scroll'))
}

const mounted: ReaderEngine[] = []

/**
 * The engine ReaderSection mounts for the chapter on screen (`href`). Its goTo lands like the real one:
 * the page moves at once (to `landAt` when a test sets it, else the locator's legacy pixel offset, else
 * the top, clamped to `pageMax`), `relocated` fires, and the browser's scroll event — the echo — a frame later.
 * `show(href)`: ReaderSection opened the next chapter in it.
 */
export function fakeEngine(href: string) {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const state = { here: null as Locator | null, landAt: null as number | null, pageMax: Infinity }
  function emit<K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) {
    listeners.get(e)?.forEach((cb) => cb(p))
  }
  const engine = {
    goTo: vi.fn(async (at: Locator): Promise<GoToResult> => {
      const before = getScroll()
      const top = Math.max(0, Math.min(state.pageMax, state.landAt ?? at.locations.legacyScrollY ?? 0))
      setScroll(top)
      state.here = at
      emit('relocated', { locator: at, reason: 'goTo' })
      if (top !== before) setTimeout(() => window.dispatchEvent(new Event('scroll')), 16)
      return 'exact'
    }),
    current: () => state.here,
    on: (e: string, cb: (p: unknown) => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set())
      listeners.get(e)!.add(cb)
      return () => { listeners.get(e)!.delete(cb) }
    },
  }
  const show = (h: string) => setMountedEngine({ engine: engine as unknown as ReaderEngine, href: h })
  show(href)
  mounted.push(engine as unknown as ReaderEngine)
  return { engine, state, emit, show }
}

/** afterEach: the slot is module state; a test's engine must not leak into the next. */
export function unmountFakeEngines() {
  mounted.splice(0).forEach(unmountEngine)
}
