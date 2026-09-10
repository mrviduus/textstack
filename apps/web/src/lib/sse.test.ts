import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSseParser, postSse, SseUnsupportedError, SseUnauthorizedError, type SseEvent } from './sse'

function collect() {
  const events: SseEvent[] = []
  return { events, onEvent: (e: SseEvent) => events.push(e) }
}

describe('createSseParser', () => {
  it('parses event + data with blank-line dispatch', () => {
    const { events, onEvent } = collect()
    const p = createSseParser(onEvent)
    p.feed('event: delta\ndata: Hello\n\nevent: done\ndata: {"cached":false}\n\n')

    expect(events).toEqual([
      { event: 'delta', data: 'Hello' },
      { event: 'done', data: '{"cached":false}' },
    ])
  })

  it('handles chunks split at arbitrary boundaries', () => {
    const { events, onEvent } = collect()
    const p = createSseParser(onEvent)
    for (const ch of 'event: delta\ndata: Hel\n\neve') p.feed(ch)
    p.feed('nt: delta\ndata: lo\n\n')

    expect(events).toEqual([
      { event: 'delta', data: 'Hel' },
      { event: 'delta', data: 'lo' },
    ])
  })

  it('joins multi-line data with newline and tolerates CRLF', () => {
    const { events, onEvent } = collect()
    const p = createSseParser(onEvent)
    p.feed('event: delta\r\ndata: line1\r\ndata: line2\r\n\r\n')

    expect(events).toEqual([{ event: 'delta', data: 'line1\nline2' }])
  })

  it('ignores comments and unknown fields; defaults event type to message', () => {
    const { events, onEvent } = collect()
    const p = createSseParser(onEvent)
    p.feed(': keep-alive\nid: 7\ndata: plain\n\n')

    expect(events).toEqual([{ event: 'message', data: 'plain' }])
  })

  it('end() flushes a trailing event without a final blank line', () => {
    const { events, onEvent } = collect()
    const p = createSseParser(onEvent)
    p.feed('event: error\ndata: boom')
    p.end()

    expect(events).toEqual([{ event: 'error', data: 'boom' }])
  })

  it('preserves data that contains colons', () => {
    const { events, onEvent } = collect()
    const p = createSseParser(onEvent)
    p.feed('data: {"a": "b:c"}\n\n')

    expect(events[0].data).toBe('{"a": "b:c"}')
  })
})

describe('postSse', () => {
  afterEach(() => vi.unstubAllGlobals())

  function sseResponse(payload: string): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  it('streams events from the response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      sseResponse('event: delta\ndata: Hi\n\nevent: done\ndata: {"cached":true}\n\n')))

    const { events, onEvent } = collect()
    await postSse('/explain', { word: 'x' }, onEvent)

    expect(events.map(e => e.event)).toEqual(['delta', 'done'])
  })

  it('maps non-OK statuses to readable errors before streaming', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })))
    await expect(postSse('/explain', {}, () => {})).rejects.toThrow(/Too many requests/)
  })

  it('throws SseUnsupportedError when the body is not streamable', async () => {
    const res = new Response(null, { status: 200 })
    Object.defineProperty(res, 'body', { value: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))

    await expect(postSse('/explain', {}, () => {})).rejects.toBeInstanceOf(SseUnsupportedError)
  })

  it('throws SseUnauthorizedError on 401 and sends credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(postSse('/books/x/ask', {}, () => {})).rejects.toBeInstanceOf(SseUnauthorizedError)
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: 'include' }))
  })
})
