import { useEffect, useRef, useState } from 'react'
import { NETWORK_RETRY_MS } from '@textstack/shared'
import { useOnline } from './useOnline'

/**
 * A cover's `[hidden, onError]`. One that fails hides for that URL only, so a newer version renders again (#1580);
 * it is tried again whenever the browser is back online (#1584), and once after NETWORK_RETRY_MS (#1591).
 */
export function useCoverRetry(url: string | null | undefined): [hidden: boolean, onError: () => void] {
  const [failed, setFailed] = useState<string | null>(null)
  const retried = useRef<string | null>(null)
  const online = useOnline()
  const wasOnline = useRef(online)
  useEffect(() => {
    // Only a return to online retries: on mount this would undo an error that fired before effects ran.
    const back = online && !wasOnline.current
    wasOnline.current = online
    if (!back) return
    retried.current = null
    setFailed(null)
  }, [online])
  useEffect(() => {
    if (!failed || retried.current === failed) return
    retried.current = failed
    const id = setTimeout(() => setFailed(null), NETWORK_RETRY_MS)
    return () => clearTimeout(id)
  }, [failed])
  return [!url || url === failed, () => setFailed(url ?? null)]
}
