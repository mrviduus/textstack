import type { ReaderEngine } from '@textstack/reader-engine'

/** The engine showing the chapter, as ReaderSection (reflow) or PdfEngineView (`pdf:<bookId>`) opened it. */
export interface MountedEngine {
  engine: ReaderEngine
  href: string
}

// ponytail: one module slot, because web mounts exactly one chapter (or one PDF) per route.
// Its refactor is out of Phase 6 (answer 6a).
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
