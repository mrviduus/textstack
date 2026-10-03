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

const SENSITIVE_URL_PARAMS = ['text', 'q', 'word', 'sentence', 'prompt', 'question']

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
