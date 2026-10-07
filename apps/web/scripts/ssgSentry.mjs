/**
 * Sentry for the ssg-worker.
 *
 * Errors only — a rebuild job that fails, a route that will not render, a poll loop that keeps
 * throwing. No tracing: this is a worker, and there is no request to follow.
 *
 * Off unless SENTRY_DSN is set, and then the SDK is not even imported, so a local run, CI and a
 * fork behave exactly as before. Same contract as the .NET hosts (TextStack.Observability).
 *
 * The privacy rules are the ones the API, Worker, MCP server and mobile app follow, ported rather
 * than shared: this file runs as plain Node inside an image that carries apps/web/scripts and its
 * production node_modules and nothing else, so it cannot import mobile's TypeScript.
 *   - no request data, no query strings, no breadcrumbs (prerender's console output quotes page
 *     HTML when a render fails, and a console breadcrumb would carry it);
 *   - tags on an allowlist, and our own;
 *   - free text redacted (credentials in URLs, bearer tokens, query strings) and truncated.
 * A failed route is reported by its path and the first line of its error, never its HTML.
 */

export const SERVICE = 'ssg-worker'

/** Same cap as the .NET scrubber: the only free text we send is our own and exception messages. */
export const MAX_TEXT_LENGTH = 512

/** Per job. A broken API fails every route at once; twenty events say that as well as two thousand. */
export const MAX_ROUTE_EVENTS_PER_JOB = 20

export const REDACTED = '[redacted]'

export const ALLOWED_TAGS = ['service', 'ssg.job_id', 'ssg.route', 'ssg.route_type']
export const ALLOWED_EXTRAS = ['reason', 'failed_routes_in_job']

/**
 * The .NET hosts report the deploy environment as "Production" and downgrade it to this when the
 * process carries no release: every CI-built image has one, a hand-run script never does. A
 * developer's run with the production DSN must not read as a production incident.
 */
export const UNVERIFIED_PRODUCTION = 'production-unverified'

/** `Sentry.init` options, or null when reporting is off. Pure — the tests drive it. */
export function sentryOptions(env = process.env) {
  const dsn = env.SENTRY_DSN?.trim()
  if (!dsn) return null

  const environment = env.SENTRY_ENVIRONMENT?.trim() || 'Production'
  // A developer machine does not belong in the error tracker (see SentryBootstrap.Resolve).
  if (environment.toLowerCase() === 'development') return null

  const release = env.SENTRY_RELEASE?.trim() || undefined
  return {
    dsn,
    release,
    environment: environment.toLowerCase() === 'production' && !release ? UNVERIFIED_PRODUCTION : environment,
    sendDefaultPii: false,
    // Integrations are chosen by hand (see initSentry). The defaults include console and HTTP
    // breadcrumbs, request data and local-variable capture — every one of them a way for page HTML
    // or a query string to leave the process.
    defaultIntegrations: false,
    // No tracing, so the SDK need not install OpenTelemetry's context manager and sampler either.
    skipOpenTelemetrySetup: true,
    initialScope: { tags: { service: SERVICE } },
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
    beforeSendTransaction: () => null,
  }
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

/** The URL without its query string and fragment. */
export function stripQuery(url) {
  if (!url) return url
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

const SECRET_PATTERNS = [
  // user:password@ in a connection string or URL (DATABASE_URL carries one).
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`],
  // Every prefix we issue: tsk_ (McpKeys), tso_/tsr_/tsc_ (OAuth). The test reads them from the C#.
  [/\bts[kocr]_[A-Za-z0-9_-]+/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED],
  // A query string inside text — a '?' followed by key=value, cut to the next whitespace.
  [/\?[\w.%[\]-]+=\S*/g, ''],
]

/** Credentials and query strings removed, then truncated. */
export function cleanText(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out.length <= MAX_TEXT_LENGTH ? out : `${out.slice(0, MAX_TEXT_LENGTH)}…`
}

/** `beforeSend`. Mutates and returns the event; never returns null — there is nothing to drop. */
export function scrubEvent(event) {
  delete event.breadcrumbs
  delete event.user

  if (event.request) {
    if (event.request.url) event.request.url = stripQuery(event.request.url)
    delete event.request.query_string
    delete event.request.data
    delete event.request.cookies
    delete event.request.headers
  }

  if (event.tags) {
    for (const key of Object.keys(event.tags)) {
      if (!ALLOWED_TAGS.includes(key)) delete event.tags[key]
    }
  }

  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      if (!ALLOWED_EXTRAS.includes(key)) event.extra[key] = REDACTED
      else if (typeof event.extra[key] === 'string') event.extra[key] = cleanText(event.extra[key])
    }
  }

  if (event.message) event.message = cleanText(event.message)
  for (const ex of event.exception?.values ?? []) ex.value = cleanText(ex.value)

  return event
}

// ── What gets reported ───────────────────────────────────────────────────────

/** A render that prerender skips on purpose: the page is a 404 or a draft, so there is no file. */
const NOINDEX = 'Page has noindex meta tag'

/**
 * The routes worth an event, from prerender's results file: still failed after its retries, and not
 * deliberately skipped. Each carries the first line of its error only — prerender appends the
 * page's console output and a slice of its HTML below that line.
 */
export function routeFailuresToReport(results) {
  if (!Array.isArray(results)) return []
  return results
    .filter((r) => r && r.success === false && r.error !== NOINDEX)
    .map((r) => ({
      route: stripQuery(String(r.route ?? '')),
      routeType: String(r.routeType ?? 'unknown'),
      reason: cleanText(String(r.error ?? 'unknown').split('\n')[0]),
    }))
}

/**
 * Starts Sentry when SENTRY_DSN is set and returns the reporter, or null. The SDK is imported here,
 * so an unset DSN never loads it.
 */
export async function initSentry(env = process.env, overrides = {}) {
  const options = sentryOptions(env)
  if (!options) return null

  const Sentry = await import('@sentry/node')
  Sentry.init({
    ...options,
    integrations: [
      // Both keep Node's own outcome — the process exits, and compose restarts it. Sentry's default
      // for rejections is 'warn', which would quietly turn a crash into a worker that carries on.
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
      Sentry.linkedErrorsIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    ...overrides,
  })

  // Tags travel with each event (capture context), never on a scope: without OpenTelemetry's
  // context manager, withScope did not isolate, and a job's tags landed on the next, unrelated event.
  return {
    /** A rebuild job ended Failed. */
    jobFailed(jobId, error) {
      Sentry.captureException(error, { tags: { 'ssg.job_id': String(jobId) } })
    },

    /** Routes that did not render. One event each, capped; grouped into one issue by Sentry. */
    routesFailed(jobId, failures) {
      for (const f of failures.slice(0, MAX_ROUTE_EVENTS_PER_JOB)) {
        Sentry.captureMessage('SSG route failed to render', {
          level: 'error',
          tags: { 'ssg.job_id': String(jobId), 'ssg.route': f.route, 'ssg.route_type': f.routeType },
          extra: { reason: f.reason, failed_routes_in_job: failures.length },
          fingerprint: ['ssg-route-failed'],
        })
      }
    },

    /** Anything else: the poll loop, a fatal error. */
    error(error) {
      Sentry.captureException(error)
    },

    /** Sends what is queued. Call before the process exits. */
    close(timeoutMs = 2000) {
      return Sentry.close(timeoutMs)
    },
  }
}
