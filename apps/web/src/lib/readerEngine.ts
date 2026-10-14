import type { ReaderEngine } from '@textstack/reader-engine'

/** An owner override: `?engine=<on>` keeps it on in this browser, `?engine=<off>` clears it. */
interface Override { key: string; on: string; off: string }
const REFLOW_OVERRIDE: Override = { key: 'textstack:reader-engine', on: '1', off: '0' }
/** Phase 5 (answer 2b): the PDF engine has its own flag, so a PDF rollback never rolls reflow back. */
export const PDF_OVERRIDE: Override = { key: 'textstack:reader-engine-pdf', on: 'pdf', off: 'pdf0' }

/**
 * ADR-025 Phase 4: reflow chapters are read through the reader engine. `VITE_READER_ENGINE=true`
 * (apps/web/production.env) turns it on for everyone; before that, `?engine=1` turns it on for this
 * browser (kept in localStorage, `?engine=0` clears it) so the owner can try it on prod. Phase 5: the
 * same for PDFs with `VITE_READER_ENGINE_PDF` and `?engine=pdf` / `?engine=pdf0`. The overrides go in Phase 6.
 */
export function readerEngineEnabled(env: string | undefined, search: string, storage: Storage | null, o: Override = REFLOW_OVERRIDE): boolean {
  if (env === 'true') return true
  if (!storage) return false
  const q = new URLSearchParams(search).get('engine')
  if (q === o.on) storage.setItem(o.key, '1')
  if (q === o.off) storage.removeItem(o.key)
  return storage.getItem(o.key) === '1'
}

function localStorageOrNull(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/** Read once per page load, at app start (main.tsx imports this): the reader never switches engines mid-chapter. */
export const READER_ENGINE = typeof window !== 'undefined'
  && readerEngineEnabled(import.meta.env.VITE_READER_ENGINE, window.location.search, localStorageOrNull())

/** The Original-layout PDF through the engine's fixed layout (Phase 5 slice 3); read once, like READER_ENGINE. */
export const READER_ENGINE_PDF = typeof window !== 'undefined'
  && readerEngineEnabled(import.meta.env.VITE_READER_ENGINE_PDF, window.location.search, localStorageOrNull(), PDF_OVERRIDE)

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

