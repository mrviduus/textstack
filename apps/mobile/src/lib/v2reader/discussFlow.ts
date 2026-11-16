/**
 * The Android host's "Discuss this chapter" from the tap to what the pill shows (#1316), apart from the screen so it
 * is tested: are any assistants connected, which server book the open bytes are, the share (the shared
 * `createV2Discuss`), then the chat. Every wait has a deadline or belongs to the controller, and every wait is
 * followed by the identity guard.
 */
import {
  SHARE_MS, V2DiscussError, connectedAssistants, discussFailureOf, withDeadline,
  type V2DiscussFailure, type V2DiscussShared,
} from '@textstack/shared'

/** One chapter's Discuss, as the host holds it (undefined: not asked, or nothing to show). */
export type V2DiscussState =
  | { phase: 'sharing' }
  | { phase: 'ready'; shared: V2DiscussShared }
  | { phase: 'failed'; reason: V2DiscussFailure }

export interface DiscussFlowDeps {
  /** May this user connect an assistant at all (a guest may not: no request is made for one). */
  canConnect: boolean
  /** The reader's connected apps, straight from the server: a failure is a failure, never "none". */
  grants(): Promise<readonly { clientName: string }[]>
  /** The server ids of the open bytes; null when this device holds no book for them. */
  serverBook(): Promise<{ bookId: string; fileId: string | null } | null>
  /** The share itself (`createV2Discuss().discuss`): null when the identity changed meanwhile. */
  share(server: { bookId: string; fileId: string | null }): Promise<V2DiscussShared | null>
  /** Still the user, the session and the open book the tap was made under. */
  current(): boolean
  /** Shows how to connect an assistant. */
  showConnect(): void
  /** Opens the chat with a built message. */
  openChat(shared: V2DiscussShared): void
  timeoutMs?: number
}

/**
 * Runs one Discuss; the state to show after it (undefined: nothing, the idle pill). The chat is opened only with a
 * share the server answered, never with an empty message; with no assistant connected nothing is shared and the
 * connect sheet shows; a grants request that fails or does not answer is said as that (offline, a timeout), with a
 * retry, never read as "none connected".
 */
export async function runDiscuss(deps: DiscussFlowDeps): Promise<V2DiscussState | undefined> {
  try {
    const grants = deps.canConnect ? await withDeadline(deps.grants(), deps.timeoutMs ?? SHARE_MS) : []
    if (!deps.current()) return undefined
    if (connectedAssistants(grants).length === 0) {
      deps.showConnect()
      return undefined
    }
    const server = await deps.serverBook()
    if (!deps.current()) return undefined
    if (!server) throw new V2DiscussError('noBook')
    const shared = await deps.share(server)
    if (!shared || !deps.current()) return undefined
    deps.openChat(shared)
    return { phase: 'ready', shared }
  } catch (e) {
    if (!deps.current()) return undefined
    return { phase: 'failed', reason: discussFailureOf(e) }
  }
}

/**
 * The chapters a Discuss is running for, of one open book: a tap on a chapter already running does nothing, any
 * other chapter is free. `reset()` where a book opens or closes: a run of the previous book holds nothing of the
 * next one's (its own `release` then frees nothing).
 */
export function createDiscussLocks() {
  let held = new Set<string>()
  return {
    /** Takes the chapter; its release, or null when it is already running. */
    take(key: string): (() => void) | null {
      if (held.has(key)) return null
      const mine = held
      mine.add(key)
      return () => { mine.delete(key) }
    },
    reset() { held = new Set() },
  }
}
