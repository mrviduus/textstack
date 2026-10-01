import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { LibraryEntryStatus } from '@textstack/shared'

export type LibraryStatus = LibraryEntryStatus
export const DEFAULT_STATUS: LibraryStatus = 'all'

const VALID: LibraryStatus[] = ['all', 'reading', 'finished', 'notStarted', 'failed']

function readStatus(value: string | null): LibraryStatus {
  if (!value) return DEFAULT_STATUS
  return (VALID as string[]).includes(value) ? (value as LibraryStatus) : DEFAULT_STATUS
}

export interface LibraryStatusState {
  status: LibraryStatus
  setStatus: (next: LibraryStatus) => void
}

export function useLibraryStatus(): LibraryStatusState {
  const [searchParams, setSearchParams] = useSearchParams()
  const status = readStatus(searchParams.get('status'))

  const setStatus = useCallback(
    (next: LibraryStatus) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev)
          if (next === DEFAULT_STATUS) sp.delete('status')
          else sp.set('status', next)
          return sp
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  return useMemo(() => ({ status, setStatus }), [status, setStatus])
}
