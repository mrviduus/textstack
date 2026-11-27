import { useCallback, useEffect, useState } from 'react'
import type { TagCount } from '../api/userBooks'
import { platform } from '../platform'

const CACHE_TTL_MS = 60_000

let cache: { ts: number; data: TagCount[] } | null = null
let inflight: Promise<TagCount[]> | null = null
const subscribers = new Set<(data: TagCount[]) => void>()

async function loadTags(force: boolean): Promise<TagCount[]> {
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const data = await platform.library.getUserTags()
      cache = { ts: Date.now(), data }
      subscribers.forEach((s) => s(data))
      return data
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function invalidateUserTagsCache() {
  cache = null
}

export function useUserTags() {
  const [tags, setTags] = useState<TagCount[]>(() => cache?.data ?? [])
  const [loading, setLoading] = useState(!cache)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const sub = (data: TagCount[]) => { if (mounted) setTags(data) }
    subscribers.add(sub)
    loadTags(false)
      .then((data) => { if (mounted) { setTags(data); setLoading(false) } })
      .catch((e) => { if (mounted) { setError(e?.message ?? 'Failed'); setLoading(false) } })
    return () => { mounted = false; subscribers.delete(sub) }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await loadTags(true)
      setTags(data)
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed')
    } finally {
      setLoading(false)
    }
  }, [])

  return { tags, loading, error, refresh }
}
