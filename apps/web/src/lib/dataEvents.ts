// Unified, typed cross-component data-change bus.
//
// Problem: most pages own their own fetch hook (useLibrary, useVocabulary,
// useHighlights, etc). When a mutation happens in component A (say, the
// reader saves a vocab word) component B (the Vocabulary page) doesn't know
// to refetch because it has a separate hook instance. Result: stale UI until
// remount.
//
// Solution: every mutator calls `emitDataChange('<entity>')`; every consumer
// uses `useDataChange('<entity>', refetch)`. One source of truth, type-safe,
// no global store needed.
//
// Multiple entities can be passed as an array — listener fires on any of
// them changing.

import { useEffect } from 'react'

export type DataEntity =
  // Books
  | 'user-books'        // user-uploaded books (UserBook entity)
  | 'shelves'           // homepage/library shelves cache
  // Reader-adjacent
  | 'reading-progress'
  | 'highlights'
  | 'bookmarks'
  | 'vocabulary'
  // Organization
  | 'collections'
  | 'tags'

const PREFIX = 'textstack:data:'

export function emitDataChange(entity: DataEntity, detail?: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PREFIX + entity, { detail }))
}

// Convenience: emit several at once. E.g. deleting a user book invalidates
// both `user-books` and the cached `shelves`.
export function emitDataChanges(entities: DataEntity[], detail?: unknown): void {
  for (const e of entities) emitDataChange(e, detail)
}

export function useDataChange(
  entity: DataEntity | DataEntity[],
  callback: () => void,
): void {
  useEffect(() => {
    const list = Array.isArray(entity) ? entity : [entity]
    const handler = () => callback()
    for (const e of list) window.addEventListener(PREFIX + e, handler)
    return () => {
      for (const e of list) window.removeEventListener(PREFIX + e, handler)
    }
    // We intentionally don't depend on `callback` identity. Consumers should
    // wrap their refetch in useCallback if needed; otherwise we'd re-bind
    // listeners on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(entity) ? entity.join('|') : entity])
}
