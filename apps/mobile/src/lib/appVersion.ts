/**
 * Which build is calling, and is it still allowed to (review #23).
 *
 * The app sends `X-App-Version` / `X-App-Build` on every request so the server can
 * tell builds apart in logs, traces and Sentry. The server publishes
 * `Mobile:MinSupportedBuild` at `GET /app/config`; below it, `ForceUpdateGate`
 * covers the app with "Please update". Every failure here resolves to "do not
 * block" — reading never waits on the network.
 *
 * The gate compares the BUILD number (Android versionCode), not the version name:
 * every build reports "1.0.0" because EAS bumps only versionCode, so a name-based
 * minimum would block the newest build too and updating would not clear it.
 */

/** Header map for the shared client. Empty where there is no native build (web). */
export function appVersionHeaders(
  version: string | null | undefined,
  build: string | number | null | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (version) headers['X-App-Version'] = version
  if (build != null && build !== '') headers['X-App-Build'] = String(build)
  return headers
}

/** A positive integer, or null for anything else (null, '', 'abc', 0, negatives, 1.5). */
function toBuild(v: string | number | null | undefined): number | null {
  const n = typeof v === 'number' ? v : /^\s*\d+\s*$/.test(v ?? '') ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * True only when both are real build numbers and current is strictly lower. No
 * minimum, an unknown current build (web, dev) or a garbage value all mean "don't
 * block": a misconfiguration must not lock every reader out.
 */
export function isBelowBuild(
  currentBuild: string | number | null | undefined,
  otherBuild: string | number | null | undefined,
): boolean {
  const current = toBuild(currentBuild)
  const other = toBuild(otherBuild)
  return current != null && other != null && current < other
}

/** The blocking gate's comparison. Same rule as `isBelowBuild`; kept under its own name for the call site. */
export const isBelowMinimumBuild = isBelowBuild

export type BuildGate = 'ok' | 'nudge' | 'blocked'

/**
 * `blocked` below the minimum; `nudge` below the latest (a dismissible bar); else `ok`.
 * Every unusable input resolves to `ok` — a bad config must never nag or lock anyone.
 */
export function buildGate(
  currentBuild: string | number | null | undefined,
  cfg: { minSupportedBuild?: number | null; latestBuild?: number | null },
): BuildGate {
  if (isBelowMinimumBuild(currentBuild, cfg.minSupportedBuild)) return 'blocked'
  if (isBelowBuild(currentBuild, cfg.latestBuild)) return 'nudge'
  return 'ok'
}

/**
 * Whether the "new version" bar shows. Never in the reader (it would sit over the text and its
 * controls), never on top of the legacy-runtime banner (same message), and a dismissal covers only
 * the `latest` it was made for, so a newer build brings the bar back.
 */
export function nudgeVisible(s: {
  gate: BuildGate
  latest: number | null
  dismissedFor: number | null
  reading: boolean
  legacyBanner: boolean
}): boolean {
  return s.gate === 'nudge' && !s.reading && !s.legacyBanner && s.latest !== s.dismissedFor
}

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Foreground re-checks at most once a day. Null = never checked this launch. */
export function isCheckDue(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt == null || now - lastCheckedAt >= CHECK_INTERVAL_MS
}
