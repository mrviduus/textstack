/**
 * "Discuss this chapter" on the V2 reader (#1316): the chapter's text is shared with the reader's own account
 * (`POST /me/v2/books/{id}/shares`), and the chat opens with a share id. The assistant reads that share with
 * `get_shared_chapter`; nothing of the book travels in the link. Platform-agnostic: both hosts give it the page's
 * answer, the API call and their identity guard.
 */
import { MAX_BRIEF_CHARS } from './assistantHandoff'
import { connectedAssistants } from './chapterReview'
import { clip } from '../reader/textAnchor'
import { ApiError, isOfflineError } from '../api/client'
import { syncErrorOf, type Share, type ShareWrite } from '../api/sync'

/** The server's caps on a share's title and language (`SyncLimits.MaxChapterTitle`, `MaxLanguage`). */
const MAX_CHAPTER_TITLE = 500
const MAX_LANGUAGE = 16

/** The id line of a V2 handoff: the book, and the share the chat is about. The vocabulary is the MCP server's instructions'. */
export const shareIdLine = (bookId: string, shareId: string) => `(TextStack: book ${bookId}, share ${shareId})`

export interface DiscussBriefInput {
  /** The book's title, as the page read it from the file: untrusted text, sent as text. */
  title: string
  author?: string | null
  bookId: string
  shareId: string
  /** The contents entry's label; null in a book with no contents. */
  chapterTitle: string | null
  /** The chapter is over the share's size cap: the share holds its first part only, and the message says so. */
  cut: boolean
}

/**
 * A title cut to `n` UTF-16 units with an ellipsis, never through a surrogate pair (half of one is refused by
 * `encodeURIComponent` and by the server's text check).
 */
const clipTitle = (s: string, n: number) => (s.length <= n ? s : `${clip(s, n - 1).trimEnd()}…`)

/** The opening message the reader sees and sends: one sentence, the cut said in words, the id line. Titles are clipped so the id line survives the cap. */
export function buildDiscussBrief(input: DiscussBriefInput): string {
  const author = input.author ? ` by ${clipTitle(input.author, 120)}` : ''
  const where = input.chapterTitle ? `, at the chapter "${clipTitle(input.chapterTitle, 200)}"` : ''
  const cut = input.cut ? ' It is a long chapter: only its first part is shared.' : ''
  const brief = `I'm reading "${clipTitle(input.title, 200)}"${author} in TextStack${where}. Let's talk about it.${cut}\n\n${shareIdLine(input.bookId, input.shareId)}`
  // Unreachable with the clips above (under 800 characters); kept so a later edit cannot push the id line out unseen.
  if (brief.length > MAX_BRIEF_CHARS) throw new Error('discuss brief over the URL cap')
  return brief
}

/** Why a share did not happen, as the reader is told. */
export type DiscussFailure =
  /** The chapter has no text (images only). */
  | 'empty'
  /** The page cannot read this chapter (no such entry, a format without text of its own, no answer in time). */
  | 'unavailable'
  | 'offline'
  /** The session ended. */
  | 'signedOut'
  /** The server does not have this book (not synced yet, or removed). */
  | 'noBook'
  /** No answer in time (a share, or the list of connected assistants): it may yet land; the retry replays it. */
  | 'timeout'
  | 'failed'

export class DiscussError extends Error {
  constructor(public readonly reason: DiscussFailure) {
    super(`discuss: ${reason}`)
  }
}

/** A failed share call as the reader is told it. */
export function discussFailureOf(e: unknown): DiscussFailure {
  if (e instanceof DiscussError) return e.reason
  if (isOfflineError(e)) return 'offline'
  if (e instanceof ApiError && e.status === 401) return 'signedOut'
  const code = syncErrorOf(e)?.code
  if (code === 'book_not_found' || code === 'book_removed' || code === 'unknown_file') return 'noBook'
  return 'failed'
}

export interface DiscussChapter {
  bookId: string
  /** The server file the open bytes are; null when not known (the share then carries no file version). */
  fileId: string | null
  /** `chapterKey` of chapters.mjs: stable for one file version. */
  chapterKey: string
  chapterTitle: string | null
  bookTitle: string
  author?: string | null
  /** The book's language as the page read it; left out when it does not fit the server's cap (`MAX_LANGUAGE`). */
  language?: string | null
}

export interface DiscussDeps {
  /** The chapter's text from the page (`readChapterText`): rejects with a `DiscussError` when there is none. */
  chapterText(): Promise<{ text: string; cut: boolean }>
  share(bookId: string, body: ShareWrite): Promise<Share>
  /**
   * The identity guard: still the account and the open book the reader asked for. Checked after every wait;
   * once false nothing is sent and nothing is handed over.
   */
  current(): boolean
  /** One id per chapter and open book, so a retry replays the first share instead of making a second. */
  operationId: string
}

export interface DiscussShared { brief: string; shareId: string; cut: boolean }

/**
 * Shares the chapter and builds the handoff. Null: the reader's identity or book changed meanwhile (say nothing).
 * Throws a `DiscussError` for everything the reader should be told. The handoff exists only once the server
 * answered with a share id of this book: a failed or offline share never yields one.
 */
export async function shareChapterForDiscuss(chapter: DiscussChapter, deps: DiscussDeps): Promise<DiscussShared | null> {
  const { text, cut } = await deps.chapterText()
  if (!deps.current()) return null
  let shared: Share
  try {
    shared = await deps.share(chapter.bookId, {
      operationId: deps.operationId,
      fileId: chapter.fileId,
      chapterKey: chapter.chapterKey,
      chapterTitle: chapter.chapterTitle ? clip(chapter.chapterTitle, MAX_CHAPTER_TITLE) : null,
      chapterText: text,
      notes: [],
      language: chapter.language && chapter.language.length <= MAX_LANGUAGE ? chapter.language : null,
    })
  } catch (e) {
    if (!deps.current()) return null
    throw new DiscussError(discussFailureOf(e))
  }
  if (!deps.current()) return null
  // The answer is the server's, but an id is only handed over when it is one, of this book.
  if (typeof shared?.id !== 'string' || !UUID.test(shared.id) || shared.bookId !== chapter.bookId) throw new DiscussError('failed')
  return {
    shareId: shared.id,
    cut,
    brief: buildDiscussBrief({ title: chapter.bookTitle, author: chapter.author, bookId: chapter.bookId, shareId: shared.id, chapterTitle: chapter.chapterTitle, cut }),
  }
}

/** The page's `chapter-text` answer as a host read it (`readChapterText`, chapters.mjs). */
export type ChapterTextAnswer = { request: string; text: string; cut: boolean } | { request: string; error: 'empty' | 'unavailable' }

/** A chapter as the page names it, with what its share carries. */
export interface DiscussRequest extends DiscussChapter { tocIndex: number | null; section: number }

/** No `chapter-text` from the page by then: the chapter is not shared, and the reader is told. */
export const CHAPTER_TEXT_MS = 20000
/** No answer from the server by then (the API client has no deadline of its own): said as `timeout`, with a retry. */
export const SHARE_MS = 30000

/** `work`, or a `DiscussError('timeout')` after `ms`: a call that never answers does not hold its button forever. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DiscussError('timeout')), ms)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * One host's Discuss for the open book (both hosts): asks the page for a chapter's text under a request id of its
 * own, shares it, and keeps one operation id per chapter so a retry replays the first share. One share at a time
 * per chapter (`busy`). `reset()` where a book opens: the previous book's ids and waits are none of the new one's.
 */
export function createDiscuss(deps: {
  /** Sends the page `chapterText(request, tocIndex, section)`. */
  askPage(request: string, chapter: { tocIndex: number | null; section: number }): void
  share(bookId: string, body: ShareWrite): Promise<Share>
  newId(): string
  timeoutMs?: number
  shareTimeoutMs?: number
}) {
  const waiting = new Map<string, (a: ChapterTextAnswer) => void>()
  let operations = new Map<string, string>()
  let sharing = new Set<string>()
  return {
    /** The page's answer: taken only for a request this host made and still waits for. */
    answer(a: ChapterTextAnswer | null) {
      const take = a && waiting.get(a.request)
      if (!a || !take) return
      waiting.delete(a.request)
      take(a)
    },
    busy: (chapterKey: string) => sharing.has(chapterKey),
    reset() {
      operations = new Map()
      sharing = new Set()
    },
    /** As `shareChapterForDiscuss`; `current` is the host's identity guard. Call only when not `busy`. */
    async discuss(chapter: DiscussRequest, current: () => boolean): Promise<DiscussShared | null> {
      const key = chapter.chapterKey
      const [ops, inFlight] = [operations, sharing]
      let operationId = ops.get(key)
      if (!operationId) ops.set(key, (operationId = deps.newId()))
      inFlight.add(key)
      try {
        return await shareChapterForDiscuss(chapter, {
          operationId,
          current,
          // A share that lands after its deadline is found again by the retry: the same operation id replays it.
          share: (bookId, body) => withDeadline(deps.share(bookId, body), deps.shareTimeoutMs ?? SHARE_MS),
          chapterText: () => new Promise((resolve, reject) => {
            const request = deps.newId()
            const timer = setTimeout(() => {
              waiting.delete(request)
              reject(new DiscussError('unavailable'))
            }, deps.timeoutMs ?? CHAPTER_TEXT_MS)
            waiting.set(request, (a) => {
              clearTimeout(timer)
              if ('error' in a) reject(new DiscussError(a.error))
              else resolve(a)
            })
            deps.askPage(request, { tocIndex: chapter.tocIndex, section: chapter.section })
          }),
        })
      } catch (e) {
        // A refused write may be this id's (another payload under it): the next try is a new operation.
        if (discussFailureOf(e) === 'failed') ops.delete(key)
        throw e
      } finally {
        inFlight.delete(key)
      }
    },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One chapter's Discuss as a host shows it (undefined: not asked, or nothing to show): sharing; `connect` (no
 * assistant connected: the host shows how to connect one, nothing was shared); `ready` (shared: `grants` are the
 * connected apps the decision was made from, the ONE answer the chat is opened with: never asked again, never read
 * from a cache that a failed request filled with "none"); `failed` with the cause, a retry.
 */
export type DiscussState =
  | { phase: 'sharing' }
  | { phase: 'connect' }
  | { phase: 'ready'; shared: DiscussShared; grants: readonly { clientName: string }[] }
  | { phase: 'failed'; reason: DiscussFailure }

export interface DiscussRun {
  /** May this user connect an assistant at all (a guest may not: no request is made for one). */
  canConnect: boolean
  /** The reader's connected apps, straight from the server: a failure is a failure, never "none". */
  grants(): Promise<readonly { clientName: string }[]>
  /** The server ids of the open bytes; null when none (the book is not on the server). */
  serverBook(): Promise<{ bookId: string; fileId: string | null } | null>
  /** The share itself (`createDiscuss().discuss`): null when the identity changed meanwhile. */
  share(server: { bookId: string; fileId: string | null }): Promise<DiscussShared | null>
  /** Still the user, the session and the open book the tap was made under. */
  current(): boolean
  timeoutMs?: number
}

/**
 * One Discuss from the tap to the state to show, both hosts: are any assistants connected (asked once, with a
 * deadline: a failed or slow request is said as such with a retry, never read as "none connected"), which server
 * book the open bytes are, then the share. Undefined: the identity or the book changed meanwhile (show nothing).
 * The host opens the chat from a `ready` state only, with its `grants`.
 */
export async function runDiscuss(deps: DiscussRun): Promise<DiscussState | undefined> {
  try {
    const grants = deps.canConnect ? await withDeadline(deps.grants(), deps.timeoutMs ?? SHARE_MS) : []
    if (!deps.current()) return undefined
    if (connectedAssistants(grants).length === 0) return { phase: 'connect' }
    const server = await deps.serverBook()
    if (!deps.current()) return undefined
    if (!server) throw new DiscussError('noBook')
    const shared = await deps.share(server)
    if (!shared || !deps.current()) return undefined
    return { phase: 'ready', shared, grants }
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
