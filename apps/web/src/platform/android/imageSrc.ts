import { APP_HEADERS, freshAccessToken } from './api'

/**
 * An API image for an `<img>`: fetched with the bearer, answered as a blob: URL. One fetch per URL; a failed
 * one is forgotten, so the next ask tries again.
 * ponytail: memory only, so a cover does not show offline (the Expo app's image cache kept it). Keep the
 * bytes on the device (`files/v2/covers`) if the owner misses offline covers. The blob: URLs are never
 * revoked: one small image per book of the library.
 */
const loaded = new Map<string, Promise<string | undefined>>()

export function imageSrc(url: string): Promise<string | undefined> {
  let src = loaded.get(url)
  if (!src) {
    src = load(url).catch(() => undefined)
    loaded.set(url, src)
    void src.then((s) => { if (!s) loaded.delete(url) })
  }
  return src
}

async function load(url: string): Promise<string | undefined> {
  const token = await freshAccessToken()
  const res = await fetch(url, { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  return res.ok ? URL.createObjectURL(await res.blob()) : undefined
}
