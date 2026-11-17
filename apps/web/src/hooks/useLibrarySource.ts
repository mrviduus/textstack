import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export type LibrarySource = 'all' | 'uploads'

export interface LibrarySourceState {
  source: LibrarySource
  tag: string | null
  collection: string | null
  setSource: (next: LibrarySource) => void
  setTag: (next: string | null) => void
  setCollection: (next: string | null) => void
}

function readSource(value: string | null): LibrarySource {
  if (value === 'uploads') return value
  return 'all'
}

export function useLibrarySource(): LibrarySourceState {
  const [searchParams, setSearchParams] = useSearchParams()

  const source = readSource(searchParams.get('source'))
  const tag = searchParams.get('tag') || null
  const collection = searchParams.get('collection') || null

  const update = useCallback(
    (mutate: (sp: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev)
          mutate(sp)
          return sp
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const setSource = useCallback(
    (next: LibrarySource) => {
      update((sp) => {
        if (next === 'all') sp.delete('source')
        else sp.set('source', next)
        sp.delete('tag')
        sp.delete('collection')
      })
    },
    [update],
  )

  const setTag = useCallback(
    (next: string | null) => {
      update((sp) => {
        if (next) sp.set('tag', next)
        else sp.delete('tag')
        sp.delete('collection')
      })
    },
    [update],
  )

  const setCollection = useCallback(
    (next: string | null) => {
      update((sp) => {
        if (next) sp.set('collection', next)
        else sp.delete('collection')
        sp.delete('tag')
      })
    },
    [update],
  )

  return useMemo(
    () => ({ source, tag, collection, setSource, setTag, setCollection }),
    [source, tag, collection, setSource, setTag, setCollection],
  )
}
