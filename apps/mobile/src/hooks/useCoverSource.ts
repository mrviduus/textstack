import { useEffect, useRef, useState } from 'react'
import type { ImageSource } from 'expo-image'
import { getStorageUrl, NETWORK_RETRY_MS } from '@textstack/shared'
import { APP_HEADERS, freshAccessToken, getAccessToken } from '../lib/api'
import { useReconnectCount } from './useOnline'

/**
 * A cover for expo-image, and the `onError` to give it. A storage path is public; a V2 cover is a
 * full `/me/v2/books/{id}/cover` URL that needs the Bearer, so it waits for the token. expo-image
 * caches by URL, so a cover seen once shows offline; one that fails (offline, never cached) turns
 * the source undefined, so the caller shows its placeholder. It is tried again on reconnect, and once
 * after NETWORK_RETRY_MS, with a refreshed token (#1591).
 */
export function useCoverSource(path: string | null | undefined): [ImageSource | undefined, () => void] {
  const authed = !!path && /^https?:\/\//.test(path)
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (!authed) return
    let live = true
    getAccessToken().then((t) => { if (live) setToken(t) }, () => { if (live) setToken(null) })
    return () => { live = false }
  }, [authed])
  const retried = useRef<string | null>(null)
  const reconnects = useReconnectCount()
  // A retry re-reads the token: the one that failed may have expired.
  const retry = () => {
    if (!authed) { setFailed(null); return }
    freshAccessToken().then(setToken, () => {}).finally(() => setFailed(null))
  }
  useEffect(() => {
    if (reconnects === 0 || !failed) return
    retried.current = null
    retry()
  }, [reconnects]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!failed || retried.current === failed) return
    retried.current = failed
    const id = setTimeout(retry, NETWORK_RETRY_MS)
    return () => clearTimeout(id)
  }, [failed]) // eslint-disable-line react-hooks/exhaustive-deps
  const onError = () => setFailed(path ?? null)
  if (!path || path === failed) return [undefined, onError]
  if (!authed) return [{ uri: getStorageUrl(path) }, onError]
  if (token === undefined) return [undefined, onError]
  return [{ uri: path, headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, onError]
}
