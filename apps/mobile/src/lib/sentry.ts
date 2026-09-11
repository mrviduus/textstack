import * as Sentry from '@sentry/react-native'
import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { sentryEnabled } from './sentryEnabled'
import { scrubEvent, scrubUrl } from './sentryScrub'

/**
 * Crash reporting for the mobile app.
 *
 * Why this exists: until now a JS crash on a tester's device produced a fallback
 * screen and a `console.error` that reached nobody. Play Console reports native
 * crashes and ANRs, but not a caught React error, and `src/lib/analytics.ts` is a
 * complete event taxonomy wired to nothing. Going into a 14-day closed test with
 * that setup means a tester says "it crashed" and there is no way to find out why.
 *
 * Why Sentry and not Crashlytics: the backend already runs Sentry across API and
 * Worker with LLM and provider-routing spans, so this puts mobile in the same issue
 * stream — and lets a Book Chat failure be one trace from tap to OpenAI call rather
 * than two unrelated haystacks. Crashlytics would drag in Firebase, a
 * `google-services.json`, and the Advertising ID question, for a strictly worse Data
 * Safety posture and a second observability vendor.
 *
 * Design mirrors the backend's: **unset DSN means a complete no-op.** Nothing
 * initialises, nothing is sent, and the app behaves exactly as it did before. The
 * DSN is supplied through `EXPO_PUBLIC_SENTRY_DSN`.
 */

/** See {@link sentryEnabled} — the rule lives in its own module so it can be tested. */
export const isSentryEnabled = (): boolean =>
  sentryEnabled(process.env.EXPO_PUBLIC_SENTRY_DSN, __DEV__, process.env.EXPO_PUBLIC_SENTRY_IN_DEV)

export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN
  // No DSN, no SDK. Same contract as the backend: absent config is not an error.
  if (!dsn || !isSentryEnabled()) return

  Sentry.init({
    dsn,
    // Distinguishes "crashing on the native build" from "crashing on the OTA
    // published on Tuesday". Without it, a JS-only update is invisible in the
    // grouping and every fix looks like it changed nothing.
    dist: Updates.updateId ?? undefined,
    release: Constants.expoConfig?.version
      ? `app.textstack.mobile@${Constants.expoConfig.version}`
      : undefined,
    environment: __DEV__ ? 'development' : 'production',

    // Data Safety posture, deliberately the mildest bucket available:
    // no PII, no user identity attached, no session replay. Combined with the
    // scrubbing below this keeps crash data unlinked to identity on the form.
    sendDefaultPii: false,
    // Errors always; traces sampled, since this is a reading app and a paid tier
    // does not exist to fund full tracing.
    tracesSampleRate: 0.1,

    beforeSend: scrubEvent,
    beforeBreadcrumb: crumb => {
      if (crumb?.data?.url && typeof crumb.data.url === 'string') {
        crumb.data.url = scrubUrl(crumb.data.url)
      }
      return crumb
    },
  })
}

export { Sentry }
