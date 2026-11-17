/**
 * A write that survives the page unloading (like sendBeacon, but a PUT, or a bodiless DELETE), with the session cookie.
 */
export function keepaliveWrite(url: string, body: string | null, method: 'PUT' | 'DELETE' = 'PUT'): Promise<Response> {
  return fetch(url, {
    method, credentials: 'include', keepalive: true,
    ...(body === null ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
  })
}
