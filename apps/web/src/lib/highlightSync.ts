import type { StoredHighlight, HighlightAnchor, HighlightColor } from './offlineDb'
import type { PublicHighlight } from '../api/userData'

/**
 * A highlight created offline carries a client id (`<ms>-<rand>`); the server
 * mints GUIDs. That difference is how we tell "never reached the server" from
 * "server row with a pending edit".
 */
export function isLocalHighlightId(id: string): boolean {
  return /^\d+-[a-z0-9]+$/.test(id)
}

export function fromServerHighlight(sh: PublicHighlight): StoredHighlight {
  return {
    id: sh.id,
    editionId: sh.editionId || '',
    chapterId: sh.chapterId || '',
    userBookId: sh.userBookId || undefined,
    userChapterId: sh.userChapterId || undefined,
    anchor: JSON.parse(sh.anchorJson) as HighlightAnchor,
    color: sh.color as HighlightColor,
    selectedText: sh.selectedText,
    noteText: sh.noteText ?? undefined,
    syncStatus: 'synced',
    version: sh.version,
    createdAt: new Date(sh.createdAt).getTime(),
    updatedAt: new Date(sh.updatedAt).getTime(),
  }
}

// The server stores anchorJson as jsonb, which reorders keys — compare canonically.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

const anchorKey = (h: StoredHighlight) => canonical(h.anchor)

export interface HighlightSyncPlan {
  /** What the reader should see, newest first. */
  visible: StoredHighlight[]
  /** Server rows to write to IndexedDB (none that a local pending row overrides). */
  store: StoredHighlight[]
  /** Local rows to delete from IndexedDB. */
  drop: string[]
  /** Replay: POST these (client-id rows the server has never seen). */
  create: StoredHighlight[]
  /** Replay: PUT these (server rows edited offline; local wins). */
  update: StoredHighlight[]
  /** Replay: DELETE these server ids, then drop `localId` from IndexedDB. */
  remove: { serverId: string; localId: string }[]
}

/**
 * Merge a fresh server list with local IndexedDB rows. Server is the truth for
 * synced rows; local `pending` rows win and are queued for replay.
 *
 * Idempotency: POST /me/highlights has no idempotency key (server mints the id).
 * A create whose response was lost leaves a pending client-id row while the
 * server already holds it — we detect that by an identical anchor on the server
 * and adopt the server row instead of POSTing a duplicate.
 */
export function planHighlightSync(server: StoredHighlight[], local: StoredHighlight[]): HighlightSyncPlan {
  const serverIds = new Set(server.map((h) => h.id))
  const serverByAnchor = new Map(server.map((h) => [anchorKey(h), h]))
  const plan: HighlightSyncPlan = { visible: [], store: [], drop: [], create: [], update: [], remove: [] }
  const overridden = new Set<string>()

  for (const h of local) {
    if (h.syncStatus !== 'pending') {
      if (!serverIds.has(h.id)) plan.drop.push(h.id) // deleted elsewhere
      continue
    }
    const onServer = serverIds.has(h.id)
    const twin = !onServer && isLocalHighlightId(h.id) ? serverByAnchor.get(anchorKey(h)) : undefined

    if (h.deleted) {
      const serverId = onServer ? h.id : twin?.id
      if (serverId) {
        plan.remove.push({ serverId, localId: h.id })
        overridden.add(serverId)
      } else {
        plan.drop.push(h.id)
      }
    } else if (onServer) {
      plan.update.push(h)
      overridden.add(h.id)
    } else if (twin) {
      plan.drop.push(h.id) // lost-response create: server already has it
    } else if (isLocalHighlightId(h.id)) {
      plan.create.push(h)
    } else {
      plan.drop.push(h.id) // edited offline, deleted elsewhere meanwhile
    }
  }

  plan.store = server.filter((h) => !overridden.has(h.id))
  plan.visible = [...plan.store, ...plan.update, ...plan.create].sort((a, b) => b.createdAt - a.createdAt)
  return plan
}
