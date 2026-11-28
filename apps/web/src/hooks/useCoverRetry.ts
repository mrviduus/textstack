import { useEffect, useRef, useState } from 'react'
import { NETWORK_RETRY_MS } from '@textstack/shared'
import { platform } from '../platform'
import { useOnline } from './useOnline'

/**
 * A cover's `[hidden, onError, src]`. One that fails hides for that URL only, so a newer version renders again (#1580);
 * it is tried again whenever the browser is back online (#1584), and once after NETWORK_RETRY_MS (#1591).
 * `src` is what the `<img>` loads: `platform.imageSrc(url)`, the URL itself on the web, a blob: URL on Android
 * (hidden until it is there).
 */
export function useCoverRetry(url: string | null | undefined): [hidden: boolean, onError: () => void, src: string | undefined] {
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
  // The platform's answer for this URL. A promise (Android) lands in state; a retry asks again.
  const answer = url && url !== failed ? platform.imageSrc(url) : undefined
  const [fetched, setFetched] = useState<{ url: string; src: string | undefined } | null>(null)
  const pending = typeof answer === 'object'
  useEffect(() => {
    if (!url || !pending) return
    let live = true
    Promise.resolve(platform.imageSrc(url)).then((src) => {
      if (!live) return
      if (src) setFetched({ url, src })
      else setFailed(url)
    })
    return () => { live = false }
  }, [url, pending])
  const src = typeof answer === 'string' ? answer : fetched?.url === url ? fetched?.src : undefined
  return [!src, () => setFailed(url ?? null), src]
}
