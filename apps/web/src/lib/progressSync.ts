import { upsertProgress } from '../api/auth'
import { ApiError } from '../api/client'

const STORAGE_KEY_PREFIX = 'reading.progress.'

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StoredProgress {
  chapterId?: string
  chapterSlug?: string
  locator?: string
  positionJson?: string
  percent?: number
  updatedAt?: number
  synced?: boolean
}

/**
 * Flush the reading-progress entries the server has not acknowledged (`synced` unset) —
 * left by `useReadingProgress` while the user had no session, or written when a save failed. Called after a successful login/register
 * (or after bootstrap restores a real session) so switching devices / signing in later
 * does not drop progress the user accumulated while anonymous.
 *
 * Server-side LWW (updatedAt) makes order-independent writes safe; we still send
 * sequentially to avoid blowing the per-IP rate limit on first login.
 *
 * 4xx responses (edition gone, bad chapter) mean the entry is permanently broken —
 * remove it so we don't loop on the same dead keys every session. Network/5xx errors
 * keep the entry for the next retry.
 *
 * Entries already `synced` are skipped: re-sending them on every page load would rewrite the
 * server with an old position (and, before positionJson rode along, clear its TextPosition).
 * A flushed entry is marked synced (markProgressSynced), not deleted — same as the reader's
 * own writes — so restore keeps an offline fallback.
 *
 * Returns the number of entries successfully flushed.
 */
export async function flushLocalProgress(): Promise<number> {
  let keys: string[]
  try {
    keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(STORAGE_KEY_PREFIX)) keys.push(k)
    }
  } catch {
    return 0
  }
  if (keys.length === 0) return 0

  let flushed = 0
  for (const key of keys) {
    const editionId = key.slice(STORAGE_KEY_PREFIX.length)

    if (!editionId || !GUID_RE.test(editionId)) {
      try { localStorage.removeItem(key) } catch {}
      continue
    }

    let parsed: StoredProgress
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      parsed = JSON.parse(raw) as StoredProgress
    } catch {
      try { localStorage.removeItem(key) } catch {}
      continue
    }

    if (parsed?.synced) continue

    if (!parsed?.chapterId || !parsed.locator || !GUID_RE.test(parsed.chapterId)) {
      if (parsed?.chapterId && !GUID_RE.test(parsed.chapterId)) {
        try { localStorage.removeItem(key) } catch {}
      }
      continue
    }

    try {
      const updatedAt = parsed.updatedAt || Date.now()
      await upsertProgress(editionId, {
        chapterId: parsed.chapterId,
        locator: parsed.locator,
        positionJson: parsed.positionJson,
        percent: parsed.percent ?? null,
        updatedAt: new Date(updatedAt).toISOString(),
      })
      if (parsed.updatedAt) markProgressSynced(key, updatedAt)
      else try { localStorage.removeItem(key) } catch {} // unstamped legacy entry: can't be marked
      flushed++
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // 400 (bad body) / 404 (edition or chapter gone) — entry can't recover,
        // drop it so we stop retrying on every login.
        try { localStorage.removeItem(key) } catch {}
      }
      // 5xx / network — leave key so we retry next session.
    }
  }

  return flushed
}

/**
 * Restore-time choice between the local entry and the server row, without comparing
 * timestamps: the local one is this browser's `Date.now()`, the server's `updatedAt` is the
 * server's clock (the two-clocks bug #695 fixed server-side). The DTO carries no client stamp.
 *
 * Rule: a local write the server has not acknowledged (`synced` unset) is this device's latest
 * intent and wins; once acknowledged, the server row is at least as new as it (the server's own
 * LWW, on client stamps, already arbitrated other devices), so the server wins.
 *
 * Once the progress DTO echoes the client stamp (`clientUpdatedAt`, same clock as
 * `local.updatedAt`), an unsynced local entry can be compared with it instead of always winning:
 * pass it here and return `local.updatedAt > serverClientUpdatedAt` in the unsynced branch —
 * both callers (useRestoreProgress, useUserBookProgress) already route through this function.
 */
/**
 * How long the reader waits for a progress GET before restoring from this device. Without a
 * bound, a hanging network meant no restore — and, since every save waits for the restore, no
 * save either.
 */
export const PROGRESS_GET_TIMEOUT_MS = 3000
/** The background re-ask after a timed-out restore: its whole point is a slow network. */
export const PROGRESS_LATE_CHECK_TIMEOUT_MS = 15_000

export function preferLocalProgress(local: { synced?: boolean } | null, hasServer: boolean): boolean {
  return !!local && (!hasServer || !local.synced)
}

/** After the server ACKs the write stamped `updatedAt`, flag the local entry as synced —
 *  unless a newer local write has replaced it since. */
export function markProgressSynced(storageKey: string, updatedAt: number): void {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return
    const entry = JSON.parse(raw) as { updatedAt?: number }
    if (entry.updatedAt === updatedAt) localStorage.setItem(storageKey, JSON.stringify({ ...entry, synced: true }))
  } catch {
    // storage unavailable / corrupt — the entry stays unsynced, so it still wins (never loses a write)
  }
}
