import { APP_HEADERS, freshAccessToken } from './api'

/**
 * An API image for an `<img>`: fetched with the bearer, answered as a blob: URL. One fetch per URL, at most
 * MAX_FETCHES at a time (a library renders every cover at once). A failed one is forgotten, so the next ask
 * tries again. `clearImages` drops them all when the account changes.
 * ponytail: memory only, so a cover does not show offline (the Expo app's image cache kept it). Keep the
 * bytes on the device (`files/v2/covers`) if the owner misses offline covers. An older version of a cover
 * (`?v=`) stays until the account changes or the app restarts.
 */
const MAX_FETCHES = 6
const loaded = new Map<string, Promise<string | undefined>>()
let running = 0
const waiting: (() => void)[] = []

export function imageSrc(url: string): Promise<string | undefined> {
  let src = loaded.get(url)
  if (!src) {
    src = queued(() => load(url)).catch(() => undefined)
    loaded.set(url, src)
    void src.then((s) => { if (!s && loaded.get(url) === src) loaded.delete(url) })
  }
  return src
}

/** The account changed: the previous account's covers leave memory. */
export function clearImages(): void {
  for (const src of loaded.values()) void src.then((s) => { if (s) URL.revokeObjectURL(s) })
  loaded.clear()
}

async function queued<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_FETCHES) await new Promise<void>((go) => waiting.push(go))
  running++
  try { return await run() } finally { running--; waiting.shift()?.() }
}

async function load(url: string): Promise<string | undefined> {
  const token = await freshAccessToken()
  const res = await fetch(url, { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  // Only an image: a captive portal answers 200 with a page.
  if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return undefined
  return URL.createObjectURL(await res.blob())
}
