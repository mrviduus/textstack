/**
 * An upload's highlights on V2 (#1025 M2.7): `/me/v2/annotations` behind the four `highlightsApi`
 * calls the reader makes, as `PublicHighlight` (`version` = the V2 revision), so
 * `useReaderHighlights` keeps its shape. With V2 off each is the legacy call.
 *
 * A highlight is its own client uuid; a reflow anchor is `textstack-anchor-v1` with the chapter key
 * it was made in (the reader's chapter id is the key on V2), a PDF one `pdf-page`. A lost write
 * (409) adopts the server's row. ponytail: no offline queue — a failed write is the toast it was (R6).
 */
import { uuid } from 'expo-modules-core'
import {
  v2Api, highlightsApi, isPdfAnchor, anchorToV2Locator, v2LocatorToAnchor, clip, MAX_SELECTED_TEXT,
  type PublicHighlight, type UpdateHighlightData, type V2Annotation, type V2AnnotationWrite, type TextAnchor, type PdfAnchor,
} from '@textstack/shared'
import { switched, v2Book, v2Store } from './v2'

// The rows last pulled or written, by id (an edit is a full write on the revision it read), and the
// books pulled since they were opened: in the session's V2 store, emptied on sign-out.
const { annotations: rows, pulled } = v2Store

const remember = (a: V2Annotation) => {
  rows.set(a.id, a)
  return a
}

/** The book was closed: its next open pulls the feed again. */
export const forgetV2Highlights = (bookId: string) => pulled.delete(bookId)

/** A highlight another device deleted: the reader removes it instead of drawing the tombstone. */
export class HighlightDeletedError extends Error {
  readonly deleted = true
  constructor(readonly id: string) {
    super('This highlight was deleted on another device.')
  }
}

export function toPublicHighlight(a: V2Annotation): PublicHighlight {
  const anchor = v2LocatorToAnchor(a.locator)
  const chapterKey = anchor && !isPdfAnchor(anchor) ? anchor.chapterId : null
  return {
    id: a.id,
    editionId: null,
    chapterId: null,
    userBookId: a.bookId,
    userChapterId: chapterKey,
    // An anchor this reader cannot resolve (an epub-cfi, or none) is its quotation, as on web.
    anchorJson: JSON.stringify(anchor ?? { exact: a.selectedText }),
    color: a.color,
    selectedText: a.selectedText,
    noteText: a.noteText,
    version: a.revision,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

/** The write for a row: the reader's anchor as a V2 locator (none for a bare `{exact}`). */
export function toV2Write(
  h: { userBookId: string; userChapterId?: string | null; anchorJson: string; color: string; selectedText: string; noteText?: string | null },
  fileId: string | null,
  expectedRevision: number | null,
): V2AnnotationWrite {
  let anchor: (TextAnchor | PdfAnchor) | null = null
  try { anchor = JSON.parse(h.anchorJson) } catch { /* no anchor */ }
  const drawable = anchor && (isPdfAnchor(anchor) || (h.userChapterId && typeof anchor.prefix === 'string'))
  return {
    expectedRevision,
    bookId: h.userBookId,
    fileId: drawable ? fileId : null,
    selectedText: clip(h.selectedText, MAX_SELECTED_TEXT),
    noteText: h.noteText?.trim() ? h.noteText : null,
    locator: drawable ? anchorToV2Locator(isPdfAnchor(anchor!) ? anchor! : { ...anchor!, chapterId: h.userChapterId! }) : null,
    color: h.color,
  }
}

/** A write lost (409): `stale_revision` adopts the server's row; `deleted` drops it here and tells the reader. */
function adopted(id: string) {
  return (e: unknown): V2Annotation => {
    const err = v2Api.v2ErrorOf(e)
    if (err?.code === 'stale_revision' && err.current) return err.current as V2Annotation
    if (err?.code === 'deleted') {
      rows.delete(id)
      throw new HighlightDeletedError(id)
    }
    throw e
  }
}

/** The book's live highlights: the feed pulled once per book open, then answered from the store. */
async function listV2(bookId: string): Promise<PublicHighlight[]> {
  if (!pulled.has(bookId)) {
    // ponytail: the feed is per user, filtered here; a per-book list when one exists.
    const { items } = await v2Api.pullAll<V2Annotation>('annotations')
    for (const a of items) remember(a)
    pulled.add(bookId)
  }
  return [...rows.values()].filter((a) => a.bookId === bookId && !a.deletedAt).map(toPublicHighlight)
}

async function createV2(data: Parameters<typeof highlightsApi.createHighlight>[0]): Promise<PublicHighlight> {
  const bookId = data.userBookId!
  const fileId = (await v2Book(bookId)).currentFile?.id ?? null
  const id = uuid.v4()
  const write = toV2Write({ ...data, userBookId: bookId }, fileId, null)
  const saved = await v2Api.putAnnotation(id, write).catch(adopted(id))
  return toPublicHighlight(remember(saved))
}

async function updateV2(id: string, data: UpdateHighlightData): Promise<PublicHighlight> {
  const row = rows.get(id)
  if (!row) throw new Error('Highlight not loaded')
  const h = toPublicHighlight(row)
  const write = toV2Write({
    userBookId: row.bookId,
    userChapterId: h.userChapterId,
    anchorJson: data.anchorJson ?? '',
    color: data.color ?? row.color,
    selectedText: data.selectedText ?? row.selectedText,
    noteText: data.noteText === undefined ? row.noteText : data.noteText,
  }, row.fileId, row.revision)
  // A note/color edit keeps the stored locator as is: anchorJson is lossy (an epub-cfi reads as a
  // bare quote, a migrated anchor may have no offsets), so rebuilding from it would break the row.
  const kept = data.anchorJson === undefined ? { ...write, fileId: row.fileId, locator: row.locator } : write
  const saved = await v2Api.putAnnotation(id, kept).catch(adopted(id))
  return toPublicHighlight(remember(saved))
}

async function deleteV2(id: string): Promise<void> {
  await v2Api.deleteAnnotation(id)
  rows.delete(id)
}

/** The reader's highlight calls for an upload, switched per call. */
export const userBookHighlightsApi = {
  ...highlightsApi,
  getUserBookHighlights: switched(listV2, highlightsApi.getUserBookHighlights),
  createHighlight: switched(createV2, highlightsApi.createHighlight),
  updateHighlight: switched(updateV2, highlightsApi.updateHighlight),
  deleteHighlight: switched(deleteV2, highlightsApi.deleteHighlight),
}
