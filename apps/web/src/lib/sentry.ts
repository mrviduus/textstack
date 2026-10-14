/**
 * Browser error reporting for web. Same contract as the backend, the ssg-worker and mobile: **no DSN, no
 * SDK** — dev, CI and e2e build without `VITE_SENTRY_DSN`, so nothing loads and nothing is sent. With
 * one (set in `apps/web/production.env`: a browser DSN is public by design), `@sentry/react` loads lazily,
 * in its own chunk (`sentryClient.ts`), off the main bundle.
 *
 * Privacy as on the other hosts: no PII, no breadcrumbs (console and fetch crumbs carry chapter text and
 * query strings), URLs without their query string, our own tags.
 */
type SentryModule = typeof import('./sentryClient')

const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim()
let sentry: Promise<SentryModule | null> | null = null

const stripQuery = (url: string) => url.replace(/[?#].*$/, '')

export function initSentry(): void {
  if (!dsn || sentry) return
  sentry = import('./sentryClient').then((Sentry) => {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      // The commit, from images.yml; unset in any other build.
      release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      initialScope: { tags: { service: 'web' } },
      beforeBreadcrumb: () => null,
      beforeSend: (event) => {
        if (event.request?.url) event.request.url = stripQuery(event.request.url)
        if (event.request) {
          delete event.request.query_string
          delete event.request.headers   // Referer carries the last page's query string
        }
        return event
      },
    })
    return Sentry
  }).catch(() => null)   // the chunk did not load (offline, a deploy replaced it): reporting stays off
}

/** An error the user saw (an error state on screen), with our tags; logged to the console as well. */
export function reportError(error: unknown, tags: Record<string, string>): void {
  console.error('[error]', tags, error)
  void sentry?.then((Sentry) => Sentry?.captureException(error, { tags }))
}
