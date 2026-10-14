import { describe, it, expect } from 'vitest'
import type { ErrorEvent } from '@sentry/react'
import { scrubEvent } from './sentry'

// The same rules as the backend's SentryScrubber and the ssg-worker: no secret leaves the browser.
describe('web Sentry scrub', () => {
  it('redacts tokens, Bearer, JWTs, MCP keys and query strings in messages, exception values and breadcrumbs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'
    const event = {
      message: `fetch /mcp/k/abc123secret failed with Bearer ${jwt}`,
      exception: { values: [
        { type: 'Error', value: 'key tsk_live_ABC-123 rejected at /api/search?q=war and peace' },
        { type: 'Error', value: 'link /en/books/x#:~:text=call me ishmael "quoted"' },
      ] },
      breadcrumbs: [{ message: 'tso_token in a crumb' }],
      request: { url: 'https://textstack.app/en/books/x?highlight=1', query_string: 'highlight=1', headers: { Referer: 'x' } },
    } as unknown as ErrorEvent

    const out = scrubEvent(event)!

    expect(out.message).toBe('fetch /mcp/k/[redacted] failed with Bearer [redacted]')
    // From ? or # to the end of the line or the next quote: no search words, decoded or not.
    expect(out.exception!.values![0].value).toBe('key [redacted] rejected at /api/search')
    expect(out.exception!.values![1].value).toBe('link /en/books/x"quoted"')
    expect(out.breadcrumbs).toBeUndefined()
    expect(out.request).toEqual({ url: 'https://textstack.app/en/books/x' })
  })
})
