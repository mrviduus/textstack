/**
 * Which build is calling, and is it still allowed to (review #23).
 *
 * The app sends `X-App-Version` / `X-App-Build` on every request so the server can
 * tell builds apart in logs, traces and Sentry. The server publishes
 * `Mobile:MinSupportedVersion` at `GET /app/config`; below it, `ForceUpdateGate`
 * covers the app with "Please update". Every failure here resolves to "do not
 * block" — reading never waits on the network.
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

/** `1.2.10` → [1, 2, 10]. Null for anything that is not dotted numbers (pre-release tags dropped). */
function parse(v: string | null | undefined): number[] | null {
  const core = v?.trim().split(/[-+]/)[0]
  if (!core || !/^\d+(\.\d+)*$/.test(core)) return null
  return core.split('.').map(Number)
}

/** -1 / 0 / 1, numeric per part (1.2.10 > 1.2.9), missing parts are 0 (1.2 == 1.2.0). Null if unparsable. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * True only when both are real versions and current is strictly older. No minimum,
 * an unknown current version, or a typo in the server config all mean "don't block":
 * a misconfiguration must not lock every reader out.
 */
export function isBelowMinimum(current: string | null | undefined, min: string | null | undefined): boolean {
  return compareVersions(current, min) === -1
}

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Foreground re-checks at most once a day. Null = never checked this launch. */
export function isCheckDue(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt == null || now - lastCheckedAt >= CHECK_INTERVAL_MS
}
