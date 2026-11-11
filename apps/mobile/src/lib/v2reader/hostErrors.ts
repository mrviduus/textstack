/**
 * A failure as the Android host shows it (#1080 item 6). A full disk surfaced raw: `ENOSPC` from the picker's
 * copy, `NotReadableError` from the page reading a book whose blob spilled to a full disk (R4 ENOSPC runs,
 * epub-engine-prototype.md), `SQLITE_FULL` from a save. Anything else is shown as it is.
 */
export const DISK_FULL = 'Not enough free storage on this device. Free some space and try again.'

const DISK_FULL_SIGNS = /ENOSPC|No space left|NotReadableError|SQLITE_FULL|database or disk is full|QuotaExceeded/i

export function hostError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return DISK_FULL_SIGNS.test(text) ? DISK_FULL : text
}
