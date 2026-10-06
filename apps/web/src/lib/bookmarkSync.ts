import { parsePdfPageLocator } from '@textstack/shared'
import { mutateBookmarks, type Bookmark } from './bookmarkStore'
import { GUID_RE } from './progressSync'
import { ApiError } from '../api/client'
import { getPublicBookmarks, createPublicBookmark, deletePublicBookmark } from '../api/userData'
import { getUserBookBookmarks, createUserBookBookmark, deleteUserBookBookmark } from '../api/userBooks'

// Offline bookmark queue — catalog books and uploads alike. Every user action is
// a local write first (a pending row, or a tombstone); the sync replays them.
// Same shape as the highlight replay (highlightSync.ts).

export type { Bookmark }

/** Owner of rows written with no session. */
export const ANON = 'anon'

export type BookmarkTarget =
  | { kind: 'edition'; bookId: string; editionId: string }
  | { kind: 'userbook'; bookId: string }

export type ChapterRef = { id: string; identifier: string }

/** One bookmark per locator: a chapter, or a PDF page. */
export const bookmarkLocator = (b: Pick<Bookmark, 'page' | 'chapterSlug'>): string =>
  b.page != null ? `page:${b.page}` : `chapter:${b.chapterSlug}`

type ServerBookmark = {
  id: string
  chapterId: string | null
  chapterSlug?: string | null
  locator: string
  title: string | null
  createdAt: string
}

export function fromServer(sb: ServerBookmark, bookId: string, owner: string): Bookmark {
  const page = parsePdfPageLocator(sb.locator)
  return {
    id: sb.id,
    bookId,
    owner,
    chapterSlug: page != null ? '' : sb.chapterSlug || sb.locator.replace(/^chapter:/, ''),
    chapterTitle: sb.title || (page != null ? `Page ${page}` : ''),
    chapterId: sb.chapterId ?? undefined,
    page,
    createdAt: new Date(sb.createdAt).getTime(),
    syncStatus: 'synced',
  }
}

/**
 * The row as `owner` sees it, or null when it is another account's.
 * - Rows from before the queue carry no owner: they were the server list as last
 *   fetched (the old load replaced local with it), so they join the reader as
 *   synced — the next server list keeps or drops them. Never re-POSTed: that would
 *   resurrect a delete made on another device, or hand one account's bookmarks to
 *   the next one to sign in.
 * - A no-session reader's rows join the account that signs in on this browser.
 */
export function claimRow(b: Bookmark, owner: string): Bookmark | null {
  if (b.owner === owner) return b
  if (b.owner === undefined) return { ...b, owner, syncStatus: 'synced' }
  if (b.owner === ANON) return { ...b, owner }
  return null
}

function claimAll(rows: Bookmark[], owner: string) {
  const mine: Bookmark[] = []
  const put: Bookmark[] = []
  for (const r of rows) {
    const c = claimRow(r, owner)
    if (!c) continue
    mine.push(c)
    if (c !== r) put.push(c)
  }
  return { mine, put }
}

const byNewest = (a: Bookmark, b: Bookmark) => b.createdAt - a.createdAt
const visible = (rows: Bookmark[]) => rows.filter((b) => !b.deleted).sort(byNewest)

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** The reader's bookmarks for a book, newest first (claims legacy/anon rows on the way). */
export function loadBookmarks(bookId: string, owner: string): Promise<Bookmark[]> {
  return mutateBookmarks(bookId, (rows) => {
    const { mine, put } = claimAll(rows, owner)
    return { put, result: visible(mine) }
  })
}

export interface BookmarkDraft {
  chapterSlug: string
  chapterTitle: string
  chapterId?: string
  page?: number | null
}

/** Add locally as pending. Re-adding a locator just removed revives that row. */
export function addLocalBookmark(bookId: string, owner: string, draft: BookmarkDraft): Promise<Bookmark> {
  return mutateBookmarks(bookId, (rows) => {
    const { mine, put } = claimAll(rows, owner)
    const loc = bookmarkLocator(draft)
    const same = mine.filter((b) => bookmarkLocator(b) === loc)
    const live = same.find((b) => !b.deleted)
    if (live) return { put, result: live }
    // Its delete may be in flight: the sync turns a revived row whose server copy
    // is gone back into a pending create.
    const tomb = same[0]
    if (tomb) {
      const revived = { ...tomb, deleted: false, chapterTitle: draft.chapterTitle }
      return { put: [...put, revived], result: revived }
    }
    const bm: Bookmark = {
      id: generateId(),
      bookId,
      owner,
      chapterSlug: draft.chapterSlug,
      chapterTitle: draft.chapterTitle,
      chapterId: draft.chapterId,
      page: draft.page ?? null,
      createdAt: Date.now(),
      syncStatus: 'pending',
    }
    return { put: [...put, bm], result: bm }
  })
}

/** Remove locally. With a session it leaves a tombstone for the sync to replay. */
export function removeLocalBookmark(bookId: string, owner: string, id: string, tombstone: boolean): Promise<void> {
  return mutateBookmarks(bookId, (rows) => {
    const row = claimAll(rows, owner).mine.find((b) => b.id === id)
    if (!row) return { result: undefined }
    return tombstone ? { put: [{ ...row, deleted: true }], result: undefined } : { del: [id], result: undefined }
  })
}

export interface BookmarkSyncPlan {
  /** Server rows to write locally. */
  store: Bookmark[]
  /** Local rows to delete. */
  drop: string[]
  /** Replay: POST these. */
  create: Bookmark[]
  /** Replay: DELETE the server row, then settle the local tombstone. */
  remove: { serverId: string; localId: string }[]
}

/**
 * Merge the server list with the reader's local rows. The server is the truth for
 * synced rows; it cannot know about a bookmark that never reached it (pending) or
 * one deleted here offline (tombstone) — replacing local with it lost the first
 * and resurrected the second.
 */
export function planBookmarkSync(server: Bookmark[], local: Bookmark[]): BookmarkSyncPlan {
  const serverIds = new Set(server.map((s) => s.id))
  const plan: BookmarkSyncPlan = { store: [], drop: [], create: [], remove: [] }
  const removed = new Set<string>()

  // A tombstone names its server row by id, else by locator (a pending row whose
  // create response was lost, a legacy row stored under a local id).
  for (const t of local) {
    if (!t.deleted) continue
    const twin = serverIds.has(t.id)
      ? t.id
      : server.find((s) => !removed.has(s.id) && bookmarkLocator(s) === bookmarkLocator(t))?.id
    if (twin && !removed.has(twin)) {
      removed.add(twin)
      plan.remove.push({ serverId: twin, localId: t.id })
    } else {
      plan.drop.push(t.id)
    }
  }

  plan.store = server.filter((s) => !removed.has(s.id))
  const live = new Set(plan.store.map(bookmarkLocator))
  for (const b of local) {
    if (b.deleted || serverIds.has(b.id)) continue // tombstone, or overwritten by `store`
    if (b.syncStatus === 'pending' && !live.has(bookmarkLocator(b))) plan.create.push(b)
    else plan.drop.push(b.id) // synced but gone from the server, or the server already has it
  }
  return plan
}

const is404 = (e: unknown) => e instanceof ApiError && e.status === 404

const api = {
  list: (t: BookmarkTarget): Promise<ServerBookmark[]> =>
    t.kind === 'edition' ? getPublicBookmarks(t.editionId) : getUserBookBookmarks(t.bookId),
  create: (t: BookmarkTarget, b: Bookmark, chapterId: string | null): Promise<ServerBookmark> =>
    t.kind === 'edition'
      ? createPublicBookmark({ editionId: t.editionId, chapterId: chapterId!, locator: bookmarkLocator(b), title: b.chapterTitle })
      : createUserBookBookmark(t.bookId, { chapterId, locator: bookmarkLocator(b), title: b.chapterTitle }),
  remove: (t: BookmarkTarget, id: string): Promise<void> =>
    t.kind === 'edition' ? deletePublicBookmark(id) : deleteUserBookBookmark(t.bookId, id),
}

/** Only a server id may reach the server; an offline cache key ("editionId:slug") resolves by slug. */
function serverChapterId(b: Bookmark, chapters?: ChapterRef[]): string | undefined {
  const id = b.chapterId && GUID_RE.test(b.chapterId)
    ? b.chapterId
    : chapters?.find((c) => c.identifier === b.chapterSlug)?.id
  return id && GUID_RE.test(id) ? id : undefined
}

export interface BookmarkSyncOptions {
  chapters?: ChapterRef[]
  /** Local rows changed: re-read them. */
  onChange?: () => void
}

// One queue for every book and caller: runs never interleave, so no pending row is
// POSTed twice. User actions are NOT queued — they are single transactions, and each
// sync step re-reads the row it settles, so an action mid-sync is never lost or undone.
let queue: Promise<void> = Promise.resolve()

/** Fetch the server list, merge, replay. Offline → local rows stand. Never rejects. */
export function syncBookmarks(target: BookmarkTarget, owner: string, opts: BookmarkSyncOptions = {}): Promise<void> {
  queue = queue.then(() => syncOnce(target, owner, opts)).catch(() => {})
  return queue
}

async function syncOnce(target: BookmarkTarget, owner: string, { chapters, onChange }: BookmarkSyncOptions) {
  const { bookId } = target
  let server: Bookmark[]
  try {
    server = (await api.list(target)).map((sb) => fromServer(sb, bookId, owner))
  } catch {
    return // offline / signed out: nothing to merge against
  }
  // Planned against the rows as they are at write time, in the same transaction.
  const plan = await mutateBookmarks(bookId, (rows) => {
    const { mine, put } = claimAll(rows, owner)
    const p = planBookmarkSync(server, mine)
    return { put: [...put, ...p.store], del: p.drop, result: p }
  })
  onChange?.()

  for (const r of plan.remove) {
    try {
      await api.remove(target, r.serverId)
    } catch (e) {
      if (!is404(e)) continue // still offline: the tombstone stays
    }
    await mutateBookmarks(bookId, (rows) => {
      const row = rows.find((b) => b.id === r.localId)
      if (!row) return { result: undefined }
      // Re-added while the DELETE was in flight: its server copy is gone, so it is new again.
      if (!row.deleted) return { put: [{ ...row, syncStatus: 'pending' }], result: undefined }
      return { del: [row.id], result: undefined }
    })
  }

  for (const b of plan.create) {
    const chapterId = b.page != null ? null : serverChapterId(b, chapters) ?? null
    if (b.page == null && !chapterId) continue // not resolvable yet: stays pending
    let saved: Bookmark
    try {
      saved = fromServer(await api.create(target, b, chapterId), bookId, owner)
    } catch {
      continue // stays pending
    }
    await mutateBookmarks(bookId, (rows) => {
      const row = rows.find((x) => x.id === b.id)
      // Removed while the POST was in flight: the server row becomes the tombstone.
      if (!row || row.deleted) return { put: [{ ...saved, deleted: true }], del: row ? [row.id] : [], result: undefined }
      return { put: [{ ...saved, chapterTitle: row.chapterTitle || saved.chapterTitle }], del: [row.id], result: undefined }
    })
  }
  if (plan.remove.length || plan.create.length) onChange?.()
}
