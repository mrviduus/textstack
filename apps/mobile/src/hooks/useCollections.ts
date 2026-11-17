import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { collectionsApi, v2Offers, type Collection } from '@textstack/shared'
import { startV2Probe } from '../lib/v2'

let cache: { ts: number; data: Collection[] } | null = null
let inflight: Promise<Collection[]> | null = null
const subs = new Set<(c: Collection[]) => void>()
const versionSubs = new Set<() => void>()
let version = 0
const TTL = 60_000

function bumpVersion() {
  version += 1
  versionSubs.forEach((s) => s())
}

async function load(force: boolean): Promise<Collection[]> {
  if (!force && cache && Date.now() - cache.ts < TTL) return cache.data
  if (inflight) return inflight
  inflight = (async () => {
    try {
      // No collections on V2 (`/me/library/collections` answers 410, #1374): none, never asked.
      if (!v2Offers(await startV2Probe(), 'collections')) return []
      const data = await collectionsApi.listCollections()
      cache = { ts: Date.now(), data }
      subs.forEach((s) => s(data))
      bumpVersion()
      return data
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function invalidateCollectionsCache() {
  cache = null
  // Bump version eagerly so subscribers can refetch derived data (collection
  // membership, etc.) without waiting for the next refresh cycle.
  bumpVersion()
}

/**
 * Subscribe to the global collections cache version. Increments on every
 * successful refresh and on every invalidation, so consumers that depend on
 * derived data (e.g. /me/library/collections/{id}/books) can refetch without
 * holding the full collection list themselves.
 *
 * Implemented with useSyncExternalStore so React batches consistent reads,
 * works correctly with concurrent rendering, and skips re-renders when the
 * snapshot is stable — all the things a hand-rolled useState+useEffect
 * subscription has to handle manually.
 */
function subscribeVersion(onChange: () => void) {
  const sub = () => onChange()
  versionSubs.add(sub)
  return () => { versionSubs.delete(sub) }
}
function getVersionSnapshot() {
  return version
}
export function useCollectionsVersion(): number {
  return useSyncExternalStore(subscribeVersion, getVersionSnapshot, getVersionSnapshot)
}

export function useCollections() {
  const [collections, setCollections] = useState<Collection[]>(() => cache?.data ?? [])
  const [loading, setLoading] = useState(!cache)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const sub = (data: Collection[]) => { if (mounted) setCollections(data) }
    subs.add(sub)
    load(false)
      .then((data) => { if (mounted) { setCollections(data); setLoading(false) } })
      .catch((e) => { if (mounted) { setError(e?.message ?? 'Failed'); setLoading(false) } })
    return () => { mounted = false; subs.delete(sub) }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await load(true)
      setCollections(data)
    } finally {
      setLoading(false)
    }
  }, [])

  const create = useCallback(async (name: string, color?: string) => {
    const c = await collectionsApi.createCollection(name, color)
    invalidateCollectionsCache()
    await refresh()
    return c
  }, [refresh])

  const update = useCallback(async (id: string, data: { name?: string; color?: string; sortOrder?: number }) => {
    const c = await collectionsApi.updateCollection(id, data)
    invalidateCollectionsCache()
    await refresh()
    return c
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await collectionsApi.deleteCollection(id)
    invalidateCollectionsCache()
    await refresh()
  }, [refresh])

  return { collections, loading, error, refresh, create, update, remove }
}
