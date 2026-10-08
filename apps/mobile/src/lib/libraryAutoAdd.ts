import { libraryApi } from '@textstack/shared'
import { wasLibraryRemoved } from './libraryRemovals'

export type AutoAddDeps = {
  wasRemoved: (editionId: string) => Promise<boolean>
  isInLibrary: (editionId: string) => Promise<boolean>
  add: (editionId: string) => Promise<unknown>
}

/**
 * A catalog book joins the library once the reader is 1% in — web's `useReaderLibraryTracking`.
 * Mobile had no equivalent, so a book read without "Save to Library" never reached the Library tab.
 *
 * Once per book per app session: the reader route remounts on every chapter, so a per-mount flag
 * would ask again each chapter. Skips a book already in the library and one the reader removed
 * (`libraryRemovals`). A failed attempt is forgotten so the next save retries.
 */
export function createLibraryAutoAdd(deps: AutoAddDeps) {
  const handled = new Set<string>()
  return async (editionId: string, bookPercent: number | null | undefined): Promise<void> => {
    if (bookPercent == null || bookPercent < 0.01 || handled.has(editionId)) return
    handled.add(editionId)
    try {
      if (await deps.wasRemoved(editionId)) return
      if (await deps.isInLibrary(editionId)) return
      await deps.add(editionId)
    } catch (e) {
      handled.delete(editionId)
      console.warn('[library] auto-add failed', e)
    }
  }
}

export const autoAddToLibrary = createLibraryAutoAdd({
  wasRemoved: wasLibraryRemoved,
  isInLibrary: async id => (await libraryApi.getLibrary()).some(item => item.editionId === id),
  add: id => libraryApi.addToLibrary(id),
})
