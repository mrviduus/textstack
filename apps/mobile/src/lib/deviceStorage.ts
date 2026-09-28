import { Platform } from 'react-native'
import { chooseEvictions, type CacheEntry } from './originalFilePolicy'
import { originalsTotalBytes } from './originalFileCache'

/**
 * What the app is holding on this device, and how to get some of it back.
 *
 * There was no such accounting at all. Two file caches exist and neither had
 * ever been measured or trimmed: the stored originals (new, budgeted in
 * `originalFileCache.ts`) and the TTS audio cache, which `useTts.ts` fills with
 * one mp3 per distinct (word, language, speed) and **deletes from only on a
 * failed download**. It grows monotonically for the life of the install and
 * shrinks only when Android reclaims the whole cache directory under pressure.
 *
 * The server-side equivalent has been doing this properly for a year —
 * `backend/src/Tts/TextStack.Tts/EdgeTtsService.cs`: TTL, size cap, a sweep on
 * an hourly timer. This is that idea at device scale and without the timer,
 * because an app that is not running does not need one.
 */

/** Where `useTts.ts` writes, expressed against the modern filesystem API. It
 *  uses `expo-file-system/legacy`'s `cacheDirectory`, which is the same place
 *  `Paths.cache` names — kept here as a constant so the two cannot drift apart
 *  silently. */
export const TTS_CACHE_DIR = 'tts'

/** A generous ceiling for cached speech. Each clip is a word or a sentence, so
 *  this is thousands of them; a reader who trips it has been using TTS for
 *  months and will not miss the oldest. */
export const TTS_CACHE_BUDGET_BYTES = 200 * 1024 * 1024

export interface DeviceStorageReport {
  /** Uploaded originals kept for offline reading. */
  originalsBytes: number
  /** Cached text-to-speech audio. */
  ttsBytes: number
  totalBytes: number
}

function fs() {
  return require('expo-file-system') as typeof import('expo-file-system')
}

function ttsDirectory() {
  const { Directory, Paths } = fs()
  return new Directory(Paths.cache, TTS_CACHE_DIR)
}

async function directoryBytes(dir: ReturnType<typeof ttsDirectory>): Promise<number> {
  try {
    if (!dir.exists) return 0
    let total = 0
    for (const entry of dir.list()) {
      const size = (entry as { size?: number | null }).size
      if (typeof size === 'number') total += size
    }
    return total
  } catch {
    return 0
  }
}

/** What the profile screen shows. Never throws — a storage figure is not worth
 *  an error state, and 0 reads as "nothing", which is the honest answer when
 *  the directory cannot be read. */
export async function measureDeviceStorage(): Promise<DeviceStorageReport> {
  if (Platform.OS === 'web') return { originalsBytes: 0, ttsBytes: 0, totalBytes: 0 }
  const [originalsBytes, ttsBytes] = await Promise.all([
    originalsTotalBytes(),
    directoryBytes(ttsDirectory()),
  ])
  return { originalsBytes, ttsBytes, totalBytes: originalsBytes + ttsBytes }
}

/**
 * Trim the speech cache to its budget, oldest first.
 *
 * Reuses `chooseEvictions` rather than repeating the arithmetic: a cache entry
 * is a cache entry, and the one judgement in there — take the oldest, and stop
 * as soon as you are under — is the same judgement. Nothing is protected here
 * because nothing is being read from this directory while the app starts, and
 * a re-fetch costs one request.
 *
 * Ordering is by file modification time, which for this cache IS the write
 * time and never updates on a hit, so it is a FIFO rather than a true LRU. That
 * is deliberate: making it an LRU would mean tracking every clip's last use for
 * a file whose only cost is one request to re-fetch.
 */
export async function sweepTtsCache(
  budgetBytes: number = TTS_CACHE_BUDGET_BYTES,
): Promise<number> {
  if (Platform.OS === 'web') return 0
  try {
    const dir = ttsDirectory()
    if (!dir.exists) return 0

    const entries: CacheEntry[] = []
    for (const item of dir.list()) {
      const name = item.name
      const bytes = (item as { size?: number | null }).size
      if (!name || typeof bytes !== 'number') continue
      const mtime = (item as { modificationTime?: number | null }).modificationTime
      entries.push({ name, bookId: name, bytes, lastUsedAt: typeof mtime === 'number' ? mtime : 0 })
    }

    const doomed = chooseEvictions(entries, budgetBytes, new Set())
    let freed = 0
    for (const entry of doomed) {
      try {
        const file = new (fs().File)(dir, entry.name)
        if (file.exists) file.delete()
        freed += entry.bytes
      } catch { /* best effort — a clip we cannot delete is not worth failing over */ }
    }
    if (freed > 0) console.warn(`[tts-cache] swept ${doomed.length} clip(s), ${freed} bytes`)
    return freed
  } catch (err) {
    console.warn('[tts-cache] sweep failed:', err)
    return 0
  }
}

/** Delete every cached clip. Offered in the profile because it is the one
 *  reclaim that costs the reader nothing but a re-fetch — unlike removing a
 *  download, which is per-book and belongs on the book. */
export async function clearTtsCache(): Promise<number> {
  if (Platform.OS === 'web') return 0
  try {
    const dir = ttsDirectory()
    if (!dir.exists) return 0
    const freed = await directoryBytes(dir)
    dir.delete()
    return freed
  } catch (err) {
    console.warn('[tts-cache] clear failed:', err)
    return 0
  }
}
