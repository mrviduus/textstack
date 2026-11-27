import type { Platform } from '.'

/** Every member throws until wave 5 (#1642) ports the offline library here. The stub only proves the build. */
const notYet = (member: string) => (): never => {
  throw new Error(`platform/android: ${member} is not implemented yet (#1642)`)
}

// Wave 5 calls `initApi` here, in bearer mode, as `web.ts` does in cookie mode.

/** The Android shell (ADR-035): a local SQLite library, device files, bearer tokens. */
export const platform: Platform = {
  transport: {
    fetchInit: notYet('transport.fetchInit'),
  },
}
