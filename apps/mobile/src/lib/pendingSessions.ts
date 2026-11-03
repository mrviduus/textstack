import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  appendPendingSession,
  drainPendingSessions,
  readingTrackingApi,
  v2Api,
  toV2Session,
  rekeyPendingSessions as rekeyQueue,
  type PendingSession,
} from '@textstack/shared'
import { onV2 } from './v2'

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

/**
 * An upload's session (it has a `clientSessionId`) to V2's idempotent PUT when V2 is on, decided
 * at send time; anything else to the legacy route, without the V2 id.
 */
const submitSession: Submit = async ({ clientSessionId, ...s }) => {
  if (!clientSessionId || !(await onV2())) return readingTrackingApi.submitSession(s)
  return v2Api.putSession(clientSessionId, toV2Session(s))
}

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

export function flushPendingSessions(submit: Submit = submitSession): Promise<void> {
  return serialized(async () => {
    const queue = await read()
    if (queue.length === 0) return
    await write(await drainPendingSessions(queue, submit))
  })
}

/** V2 guest → account merge: queued sessions name the account's book id. */
export function rekeyPendingSessions(books: Record<string, string>): Promise<void> {
  return serialized(async () => {
    const rekeyed = rekeyQueue(await read(), books)
    if (rekeyed) await write(rekeyed)
  })
}

/** Sign-out: one account's unsent sessions must not be posted under the next one. */
export function clearPendingSessions(): Promise<void> {
  return serialized(() => AsyncStorage.removeItem(KEY))
}
