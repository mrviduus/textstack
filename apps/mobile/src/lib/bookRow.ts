import {
  entryTitle, entryAuthor, entryCoverPath, entryProgress,
  type LibraryEntry, type ReadingProgressDto,
} from '@textstack/shared'

const NEW_BADGE_TTL_MS = 24 * 60 * 60 * 1000

function isNewUpload(createdAt: string | null | undefined, now: number): boolean {
  if (!createdAt) return false
  const ts = Date.parse(createdAt)
  if (Number.isNaN(ts)) return false
  return now - ts < NEW_BADGE_TTL_MS
}

/**
 * One badge system: the pill over the cover states what is wrong or new.
 * A second, differently-styled status line used to sit in the text column
 * saying the same words.
 */
export type RowPill = 'processing' | 'failed' | 'new' | null

/** Everything a shelf row or grid cell shows about a book, decided once. Pure, so both layouts agree. */
export function bookRowModel(e: LibraryEntry, progressMap: Record<string, ReadingProgressDto>, now: number = Date.now()) {
  const title = entryTitle(e) || 'Untitled'
  const author = entryAuthor(e)
  const cover = entryCoverPath(e)
  const pct = Math.round(entryProgress(e, progressMap) * 100)

  const status = e.kind === 'upload' ? e.book.status.toLowerCase() : 'ready'
  const isReady = status === 'ready' || status === 'completed'
  const isProcessing = e.kind === 'upload' && !isReady && status !== 'failed'
  const isFailed = status === 'failed'
  const finishedAt = e.kind === 'upload' ? e.book.completedAt : null
  const isFinished = e.kind === 'upload' ? (finishedAt != null || pct >= 100) : pct >= 100
  const showNew = e.kind === 'upload' && isReady && !finishedAt && isNewUpload(e.book.createdAt, now)
  const pill: RowPill = isProcessing ? 'processing' : isFailed ? 'failed' : showNew ? 'new' : null
  const lastRead = e.kind === 'saved' ? progressMap[e.item.editionId]?.updatedAt : e.book.progressUpdatedAt

  return {
    title, author, cover, pct,
    isReady, isFailed, isFinished,
    dimmed: !isReady,
    pill,
    lastRead,
    errorMessage: e.kind === 'upload' ? e.book.errorMessage : undefined,
  }
}

export type BookRowModel = ReturnType<typeof bookRowModel>
