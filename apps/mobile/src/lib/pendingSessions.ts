import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  appendPendingSession,
  drainPendingSessions,
  readingTrackingApi,
  type PendingSession,
} from '@textstack/shared'

/**
 * Reading sessions whose submit has not succeeded yet, persisted so an offline read still counts.
 *
 * This client used to `.catch(() => {})` a failed submit — on the offline-first app, so every
 * session read on a plane was thrown away. Now a session is queued first and the queue is flushed:
 * right after the session ends, on sign-in / app start and on reconnect (AuthContext). Pure rules
 * (cap, expiry, which errors are permanent) live in `@textstack/shared` and are shared with web.
 */
const KEY = 'reading.pendingSessions'

type Submit = (s: PendingSession) => Promise<unknown>

// One JS runtime, so a promise chain is enough to keep a flush from overwriting a session enqueued
// while it was in flight.
let chain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

async function read(): Promise<PendingSession[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function write(queue: PendingSession[]): Promise<void> {
  if (queue.length === 0) await AsyncStorage.removeItem(KEY)
  else await AsyncStorage.setItem(KEY, JSON.stringify(queue))
}

export function enqueuePendingSession(session: PendingSession): Promise<void> {
  return serialized(async () => write(appendPendingSession(await read(), session)))
}

export function flushPendingSessions(submit: Submit = readingTrackingApi.submitSession): Promise<void> {
  return serialized(async () => {
    const queue = await read()
    if (queue.length === 0) return
    await write(await drainPendingSessions(queue, submit))
  })
}

/** Sign-out: one account's unsent sessions must not be posted under the next one. */
export function clearPendingSessions(): Promise<void> {
  return serialized(() => AsyncStorage.removeItem(KEY))
}

export async function getPendingSessions(): Promise<PendingSession[]> {
  return read()
}
