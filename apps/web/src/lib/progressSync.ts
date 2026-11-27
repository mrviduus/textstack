import { platform } from '../platform'

/**
 * A write that survives the page unloading (like sendBeacon, but a PUT, or a bodiless DELETE), with the platform's auth (web: the session cookie).
 */
export function keepaliveWrite(url: string, body: string | null, method: 'PUT' | 'DELETE' = 'PUT'): Promise<Response> {
  const init = platform.transport.fetchInit()
  return fetch(url, {
    method, ...init, keepalive: true,
    ...(body === null ? {} : { body }),
    headers: { ...init.headers, ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
  })
}
