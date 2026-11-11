/**
 * A failure as the Android host shows it (#1080 item 6). A full disk surfaced raw (`ENOSPC` from the picker's
 * copy, `SQLITE_FULL` from a save, a quota error): one human message. `NotReadableError` (the page could not read
 * the file; in the R4 ENOSPC runs a blob spilled to a full disk, but it has other causes) gets its own. The
 * original text stays in the host's log (`fail`). Anything else is shown as it is.
 */
export const DISK_FULL = 'Not enough free storage on this device. Free some space and try again.'
export const NOT_READABLE = 'The file could not be read.'

const DISK_FULL_SIGNS = /ENOSPC|No space left|SQLITE_FULL|database or disk is full|QuotaExceeded/i

export function hostError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  if (DISK_FULL_SIGNS.test(text)) return DISK_FULL
  return /NotReadableError/.test(text) ? NOT_READABLE : text
}
