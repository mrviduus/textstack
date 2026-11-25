import { useEffect, useRef, useState } from 'react'
import { useOnline } from './useOnline'

/** How long a failed cover waits before its one retry while the browser stays online (a 502, a timeout). */
export const COVER_RETRY_MS = 5000

/**
 * A cover's `[hidden, onError]`. One that fails hides for that URL only, so a newer version renders again (#1580);
 * it is tried again whenever the browser is back online (#1584), and once after COVER_RETRY_MS (#1591).
 */
export function useCoverRetry(url: string | null | undefined): [hidden: boolean, onError: () => void] {
  const [failed, setFailed] = useState<string | null>(null)
  const retried = useRef<string | null>(null)
  const online = useOnline()
  useEffect(() => { if (online) setFailed(null) }, [online])
  useEffect(() => {
    if (!failed || retried.current === failed) return
    retried.current = failed
    const id = setTimeout(() => setFailed(null), COVER_RETRY_MS)
    return () => clearTimeout(id)
  }, [failed])
  return [!url || url === failed, () => setFailed(url ?? null)]
}
