/**
 * "Discuss this chapter" on the V2 reader (#1316): the chapter's text is shared with the reader's own account
 * (`POST /me/v2/books/{id}/shares`), and the chat opens with a share id. The assistant reads that share with
 * `get_shared_chapter`; nothing of the book travels in the link. Platform-agnostic: both hosts give it the page's
 * answer, the API call and their identity guard.
 */
import { MAX_BRIEF_CHARS, clipText } from './assistantHandoff'
import { ApiError, isOfflineError } from '../api/client'
import { v2ErrorOf, type V2Share, type V2ShareWrite } from '../api/v2'

/** The id line of a V2 handoff: the book, and the share the chat is about. The vocabulary is the MCP server's instructions'. */
export const v2ShareIdLine = (bookId: string, shareId: string) => `(TextStack: book ${bookId}, share ${shareId})`

export interface V2DiscussBriefInput {
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

/** The opening message the reader sees and sends: one sentence, the cut said in words, the id line. Titles are clipped so the id line survives the cap. */
export function buildV2DiscussBrief(input: V2DiscussBriefInput): string {
  const author = input.author ? ` by ${clipText(input.author, 120)}` : ''
  const where = input.chapterTitle ? `, at the chapter "${clipText(input.chapterTitle, 200)}"` : ''
  const cut = input.cut ? ' It is a long chapter: only its first part is shared.' : ''
  const brief = `I'm reading "${clipText(input.title, 200)}"${author} in TextStack${where}. Let's talk about it.${cut}\n\n${v2ShareIdLine(input.bookId, input.shareId)}`
  // Unreachable with the clips above (under 800 characters); kept so a later edit cannot push the id line out unseen.
  if (brief.length > MAX_BRIEF_CHARS) throw new Error('discuss brief over the URL cap')
  return brief
}

/** Why a share did not happen, as the reader is told. */
export type V2DiscussFailure =
  /** The chapter has no text (images only). */
  | 'empty'
  /** The page cannot read this chapter (no such entry, a format without text of its own, no answer in time). */
  | 'unavailable'
  | 'offline'
  /** The session ended. */
  | 'signedOut'
  /** The server does not have this book (not synced yet, or removed). */
  | 'noBook'
  | 'failed'

export class V2DiscussError extends Error {
  constructor(public readonly reason: V2DiscussFailure) {
    super(`discuss: ${reason}`)
  }
}

/** A failed share call as the reader is told it. */
export function discussFailureOf(e: unknown): V2DiscussFailure {
  if (e instanceof V2DiscussError) return e.reason
  if (isOfflineError(e)) return 'offline'
  if (e instanceof ApiError && e.status === 401) return 'signedOut'
  const code = v2ErrorOf(e)?.code
  if (code === 'book_not_found' || code === 'book_removed' || code === 'unknown_file') return 'noBook'
  return 'failed'
}

export interface V2DiscussChapter {
  bookId: string
  /** The server file the open bytes are; null when not known (the share then carries no file version). */
  fileId: string | null
  /** `chapterKey` of chapters.mjs: stable for one file version. */
  chapterKey: string
  chapterTitle: string | null
  bookTitle: string
  author?: string | null
  /** The book's language as the page read it; left out when it does not fit the server's 16 characters. */
  language?: string | null
}

export interface V2DiscussDeps {
  /** The chapter's text from the page (`readChapterText`): rejects with a `V2DiscussError` when there is none. */
  chapterText(): Promise<{ text: string; cut: boolean }>
  share(bookId: string, body: V2ShareWrite): Promise<V2Share>
  /**
   * The identity guard: still the account and the open book the reader asked for. Checked after every wait;
   * once false nothing is sent and nothing is handed over.
   */
  current(): boolean
  /** One id per chapter and open book, so a retry replays the first share instead of making a second. */
  operationId: string
}

export interface V2DiscussShared { brief: string; shareId: string; cut: boolean }

/**
 * Shares the chapter and builds the handoff. Null: the reader's identity or book changed meanwhile (say nothing).
 * Throws a `V2DiscussError` for everything the reader should be told. The handoff exists only once the server
 * answered with a share id of this book: a failed or offline share never yields one.
 */
export async function shareChapterForDiscuss(chapter: V2DiscussChapter, deps: V2DiscussDeps): Promise<V2DiscussShared | null> {
  const { text, cut } = await deps.chapterText()
  if (!deps.current()) return null
  let shared: V2Share
  try {
    shared = await deps.share(chapter.bookId, {
      operationId: deps.operationId,
      fileId: chapter.fileId,
      chapterKey: chapter.chapterKey,
      chapterTitle: chapter.chapterTitle ? clipText(chapter.chapterTitle, 500) : null,
      chapterText: text,
      notes: [],
      language: chapter.language && chapter.language.length <= 16 ? chapter.language : null,
    })
  } catch (e) {
    if (!deps.current()) return null
    throw new V2DiscussError(discussFailureOf(e))
  }
  if (!deps.current()) return null
  // The answer is the server's, but an id is only handed over when it is one, of this book.
  if (typeof shared?.id !== 'string' || !UUID.test(shared.id) || shared.bookId !== chapter.bookId) throw new V2DiscussError('failed')
  return {
    shareId: shared.id,
    cut,
    brief: buildV2DiscussBrief({ title: chapter.bookTitle, author: chapter.author, bookId: chapter.bookId, shareId: shared.id, chapterTitle: chapter.chapterTitle, cut }),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
