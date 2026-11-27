// SSE over POST (Phase 5, AI-032). EventSource can't POST a body, so streaming endpoints
// (POST /explain with `Accept: text/event-stream`) are consumed via fetch + ReadableStream,
// parsed with a minimal SSE parser (event/data fields, multi-line data, CRLF-tolerant).

import { platform } from '../platform'

export interface SseEvent {
  event: string
  data: string
}

/**
 * Stateful SSE parser: feed it raw text chunks (any split points), it dispatches complete events.
 * Subset of the SSE spec sufficient for our endpoints: `event:`/`data:` fields, blank-line dispatch,
 * multi-line data joined with \n, comment lines (:) ignored. Call `end()` to flush a trailing event
 * from a stream that closed without a final blank line.
 */
export function createSseParser(onEvent: (e: SseEvent) => void) {
  let buffer = ''
  let eventType = 'message'
  let dataLines: string[] = []

  const dispatch = () => {
    if (dataLines.length > 0) onEvent({ event: eventType, data: dataLines.join('\n') })
    eventType = 'message'
    dataLines = []
  }

  const processLine = (line: string) => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return // comment / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // Per spec a single space after the colon is stripped, further spaces are data.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventType = value
    else if (field === 'data') dataLines.push(value)
    // id/retry/unknown fields ignored
  }

  return {
    feed(chunk: string) {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        buffer = buffer.slice(nl + 1)
        processLine(line)
      }
    },
    end() {
      if (buffer.length > 0) processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
      buffer = ''
      dispatch()
    },
  }
}

/**
 * POSTs JSON and consumes the SSE response, invoking `onEvent` per event. Maps non-OK statuses to
 * readable errors BEFORE streaming (rate-limit/unavailable responses are JSON, not SSE). Throws
 * `SseUnsupportedError` when the environment can't stream (no body reader) so callers can fall back
 * to a plain JSON request.
 */
export class SseUnsupportedError extends Error {
  constructor() {
    super('Streaming not supported')
  }
}

/** The SSE request was rejected with 401 — the caller should prompt sign-in. */
export class SseUnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
  }
}

export async function postSse(
  url: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // The platform's auth (web: the cookie, needed for authed SSE and harmless for public ones).
  const init = platform.transport.fetchInit()
  const res = await fetch(url, {
    method: 'POST',
    ...init,
    headers: { ...init.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    if (res.status === 401) throw new SseUnauthorizedError()
    if (res.status === 503) throw new Error('Service unavailable')
    if (res.status === 504) throw new Error('Request timed out')
    if (res.status === 429) throw new Error('Too many requests, try again later')
    const text = await res.text()
    let error = `Request failed: ${res.status}`
    try {
      const json = JSON.parse(text)
      if (json.detail) error = json.detail
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(error)
  }

  if (!res.body) throw new SseUnsupportedError()

  const parser = createSseParser(onEvent)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
    parser.feed(decoder.decode()) // flush any trailing multi-byte sequence
    parser.end()
  } finally {
    reader.releaseLock()
  }
}
