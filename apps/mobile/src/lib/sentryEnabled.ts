/**
 * Whether this process should report to Sentry at all.
 *
 * <p>Its own module, importing nothing, because `sentry.ts` pulls in `@sentry/react-native` and
 * through it React Native's Flow-typed entry point — which the test runner cannot parse. The rule is
 * the part worth testing, so it lives where a test can reach it.</p>
 *
 * <p>Two conditions, mirroring the backend's `SentryBootstrap.Resolve`: a DSN must be configured,
 * and a development run reports nothing. Dev noise is not a tidiness problem — a stale OpenAI key in
 * a local `.env` put 141 `invalid_api_key` events into this account over a month, they sat at the
 * top of the feed, and they were eventually read as a production outage and chased as one. An error
 * tracker is only worth having if everything in it is real.</p>
 *
 * <p>The DSN deliberately stays configured locally: the point is that having it costs nothing, not
 * that it must be deleted and re-pasted. `EXPO_PUBLIC_SENTRY_IN_DEV=true` opts back in, for working
 * on this integration itself — the one case that actually wants dev events.</p>
 */
export function sentryEnabled(dsn: string | undefined, isDev: boolean, inDevFlag: string | undefined): boolean {
  if (!dsn) return false
  if (!isDev) return true
  // Exactly "true": a half-set flag ("1", "yes") must not quietly re-enable what this rule stops.
  return inDevFlag === 'true'
}
