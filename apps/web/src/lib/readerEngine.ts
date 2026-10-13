import type { ReaderEngine } from '@textstack/reader-engine'

const OVERRIDE_KEY = 'textstack:reader-engine'

/**
 * ADR-025 Phase 4: reflow chapters are read through the reader engine. `VITE_READER_ENGINE=true`
 * (apps/web/production.env) turns it on for everyone; before that, `?engine=1` turns it on for this
 * browser (kept in localStorage, `?engine=0` clears it) so the owner can try it on prod. The override
 * goes in Phase 6.
 */
export function readerEngineEnabled(env: string | undefined, search: string, storage: Storage | null): boolean {
  if (env === 'true') return true
  if (!storage) return false
  const q = new URLSearchParams(search).get('engine')
  if (q === '1') storage.setItem(OVERRIDE_KEY, '1')
  if (q === '0') storage.removeItem(OVERRIDE_KEY)
  return storage.getItem(OVERRIDE_KEY) === '1'
}

function localStorageOrNull(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/** Read once per page load, at app start (main.tsx imports this): the reader never switches engines mid-chapter. */
export const READER_ENGINE = typeof window !== 'undefined'
  && readerEngineEnabled(import.meta.env.VITE_READER_ENGINE, window.location.search, localStorageOrNull())

/** The engine showing the chapter, as ReaderSection opened it. */
export interface MountedEngine {
  engine: ReaderEngine
  href: string
}

// ponytail: one module slot, because web mounts exactly one chapter per route (the same assumption as
// useReaderScrollSync's `.reader-section__article` query). Gone with useReaderScrollSync in Phase 6.
let mounted: MountedEngine | null = null

export function setMountedEngine(m: MountedEngine): void {
  mounted = m
}

/** A destroyed engine leaves the slot, unless the next chapter's engine already holds it. */
export function unmountEngine(engine: ReaderEngine): void {
  if (mounted?.engine === engine) mounted = null
}

/** The engine, only while it shows this chapter. */
export function mountedEngineFor(href: string | undefined): MountedEngine | null {
  return href && mounted?.href === href ? mounted : null
}

