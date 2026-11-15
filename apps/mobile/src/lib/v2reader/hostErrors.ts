/**
 * A failure as the Android host shows it (#1080 item 6). A full disk surfaced raw (`ENOSPC` from the picker's
 * copy, `SQLITE_FULL` from a save, a quota error): one human message. `NotReadableError` (the page could not read
 * the file; in the R4 ENOSPC runs a blob spilled to a full disk, but it has other causes) gets its own. The
 * original text stays in the host's log (`fail`). Anything else is shown as it is. The two messages are i18n keys,
 * said through the caller's `t` (#1267).
 */
export const DISK_FULL = 'reader.v2.diskFull'
export const NOT_READABLE = 'reader.v2.notReadable'

const DISK_FULL_SIGNS = /ENOSPC|No space left|SQLITE_FULL|database or disk is full|QuotaExceeded/i

export function hostError(e: unknown, t: (key: string) => string): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  if (DISK_FULL_SIGNS.test(text)) return t(DISK_FULL)
  return /NotReadableError/.test(text) ? t(NOT_READABLE) : text
}
