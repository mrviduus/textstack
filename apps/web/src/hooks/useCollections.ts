import { useCallback, useEffect, useState } from 'react'
import { collectionsApi, type Collection } from '@textstack/shared'

const { listCollections, createCollection: apiCreate, updateCollection: apiUpdate, deleteCollection: apiDelete } = collectionsApi

let cache: { ts: number; data: Collection[] } | null = null
let inflight: Promise<Collection[]> | null = null
const subs = new Set<(c: Collection[]) => void>()
const TTL = 60_000

async function load(force: boolean): Promise<Collection[]> {
  if (!force && cache && Date.now() - cache.ts < TTL) return cache.data
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const data = await listCollections()
      cache = { ts: Date.now(), data }
      subs.forEach((s) => s(data))
      return data
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function invalidateCollectionsCache() {
  cache = null
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
    const c = await apiCreate(name, color)
    invalidateCollectionsCache()
    await refresh()
    return c
  }, [refresh])

  const update = useCallback(async (id: string, data: { name?: string; color?: string; sortOrder?: number }) => {
    const c = await apiUpdate(id, data)
    invalidateCollectionsCache()
    await refresh()
    return c
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await apiDelete(id)
    invalidateCollectionsCache()
    await refresh()
  }, [refresh])

  return { collections, loading, error, refresh, create, update, remove }
}
