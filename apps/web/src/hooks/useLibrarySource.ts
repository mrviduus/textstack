import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export type LibrarySource = 'all' | 'uploads'

export interface LibrarySourceState {
  source: LibrarySource
  tag: string | null
  setSource: (next: LibrarySource) => void
  setTag: (next: string | null) => void
}

function readSource(value: string | null): LibrarySource {
  if (value === 'uploads') return value
  return 'all'
}

export function useLibrarySource(): LibrarySourceState {
  const [searchParams, setSearchParams] = useSearchParams()

  const source = readSource(searchParams.get('source'))
  const tag = searchParams.get('tag') || null

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
      })
    },
    [update],
  )

  const setTag = useCallback(
    (next: string | null) => {
      update((sp) => {
        if (next) sp.set('tag', next)
        else sp.delete('tag')
      })
    },
    [update],
  )

  return useMemo(
    () => ({ source, tag, setSource, setTag }),
    [source, tag, setSource, setTag],
  )
}
