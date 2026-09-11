import { describe, it, expect } from 'vitest'
import { sentryEnabled } from './sentryEnabled'

/**
 * Whether the app reports to Sentry at all.
 *
 * <p>This exists because dev noise is not harmless. A stale OpenAI key in a local `.env` put 141
 * `invalid_api_key` events into this account over a month; they sat at the top of the feed, and on
 * 2026-09-11 they were read as a production outage and chased as one. The rule now matches the
 * backend's (`SentryBootstrap.Resolve`).</p>
 */
describe('sentryEnabled', () => {
  const dsn = 'https://k@o.ingest.sentry.io/1'

  it('reports in a release build with a DSN', () => {
    expect(sentryEnabled(dsn, false, undefined)).toBe(true)
  })

  it('reports nothing in development, even with a DSN configured', () => {
    // The DSN legitimately stays configured — the point is that having it costs nothing on a laptop.
    expect(sentryEnabled(dsn, true, undefined)).toBe(false)
  })

  it('opts back in for working on the integration itself', () => {
    expect(sentryEnabled(dsn, true, 'true')).toBe(true)
  })

  it('treats any value other than "true" as off', () => {
    // A half-set flag must not quietly re-enable the thing this rule exists to stop.
    for (const flag of ['1', 'yes', 'TRUE', '']) expect(sentryEnabled(dsn, true, flag)).toBe(false)
  })

  it('stays off with no DSN, opt-in or not', () => {
    expect(sentryEnabled(undefined, false, undefined)).toBe(false)
    expect(sentryEnabled(undefined, true, 'true')).toBe(false)
    expect(sentryEnabled('', false, undefined)).toBe(false)
  })
})
