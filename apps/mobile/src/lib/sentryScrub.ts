/**
 * Scrubbing rules for anything on its way to Sentry.
 *
 * Kept in its own module, importing nothing, for two reasons: the mobile vitest
 * setup only covers pure utilities under `src/lib/` (importing
 * `@sentry/react-native` pulls in React Native's Flow-typed sources, which the test
 * transformer cannot parse), and the rules are the part worth testing — the SDK
 * wiring in `sentry.ts` is configuration.
 *
 * Why scrub at all: the app exists to read books, much of it copyrighted or
 * personal. A breadcrumb that innocently records a TTS or translate call carries the
 * passage the user was reading, and shipping that to a third-party processor is a
 * disclosure we have not made and do not want to make. Query strings are the
 * carrier — `/api/tts`, `/api/translate` and `/api/explain` all
 * take the text as a parameter.
 */

const SENSITIVE_URL_PARAMS = ['text', 'q', 'query', 'search', 'word', 'sentence', 'prompt', 'question']

export function scrubUrl(url: string): string {
  if (!url) return url
  const [base, query] = url.split('?')
  if (!query) return base
  const kept = query
    .split('&')
    .map(pair => {
      const [key] = pair.split('=')
      return SENSITIVE_URL_PARAMS.includes(key.toLowerCase()) ? `${key}=[redacted]` : pair
    })
    .join('&')
  return `${base}?${kept}`
}

/** Applies {@link scrubUrl} across an event's breadcrumbs and request URL. */
export function scrubEvent<T extends { breadcrumbs?: unknown[]; request?: { url?: string } }>(event: T): T {
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs as { data?: { url?: string } }[]) {
      if (crumb?.data?.url) crumb.data.url = scrubUrl(crumb.data.url)
    }
  }
  if (event.request?.url) event.request.url = scrubUrl(event.request.url)
  return event
}

/** The URL without its query string (and fragment). Spans need the stricter cut: see below. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

type SpanLike = { description?: string; data?: Record<string, unknown> }

const SPAN_URL_KEYS = ['url', 'http.url', 'url.full']

function scrubSpan(span: SpanLike | undefined): void {
  if (!span) return
  // A fetch span's description is "GET https://…/api/search?q=<what the reader typed>".
  if (typeof span.description === 'string') span.description = stripQuery(span.description)
  const data = span.data
  if (!data) return
  delete data['http.query']
  delete data['http.fragment']
  for (const key of SPAN_URL_KEYS) {
    if (typeof data[key] === 'string') data[key] = stripQuery(data[key] as string)
  }
}

/**
 * `beforeSendTransaction`. `scrubEvent` only runs on errors (`beforeSend`); performance
 * transactions go through a different hook, and the SDK's fetch spans record the full URL —
 * description, `url`, `http.query` — so a search or a read-aloud request reached Sentry in
 * every sampled session. Spans lose the whole query string, not just the known keys: no
 * parameter in a span is worth a passage leaking under a name we forgot to list.
 */
export function scrubTransaction<
  T extends {
    breadcrumbs?: unknown[]
    request?: { url?: string; query_string?: unknown }
    spans?: SpanLike[]
    contexts?: { trace?: SpanLike }
  },
>(event: T): T {
  scrubEvent(event)
  if (event.request) {
    if (event.request.url) event.request.url = stripQuery(event.request.url)
    delete event.request.query_string
  }
  event.spans?.forEach(scrubSpan)
  scrubSpan(event.contexts?.trace)
  return event
}
