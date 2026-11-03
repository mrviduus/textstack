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
import { onV2, v2Book } from './v2'

// The rows last seen, by id: an edit is a full write on the revision it read.
const rows = new Map<string, V2Annotation>()

const remember = (a: V2Annotation) => {
  rows.set(a.id, a)
  return a
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

/** On a 409 that carries the server's row (`stale_revision`, `deleted`): that row. */
function adopted(e: unknown): V2Annotation {
  const err = v2Api.v2ErrorOf(e)
  if ((err?.code === 'stale_revision' || err?.code === 'deleted') && err.current) return err.current as V2Annotation
  throw e
}

async function listV2(bookId: string): Promise<PublicHighlight[]> {
  // ponytail: the feed is per user, filtered here; a per-book list when one exists.
  const { items } = await v2Api.pullAll<V2Annotation>('annotations')
  return items.filter((a) => a.bookId === bookId && !a.deletedAt).map((a) => toPublicHighlight(remember(a)))
}

async function createV2(data: Parameters<typeof highlightsApi.createHighlight>[0]): Promise<PublicHighlight> {
  const bookId = data.userBookId!
  const fileId = (await v2Book(bookId)).currentFile?.id ?? null
  const id = uuid.v4()
  const write = toV2Write({ ...data, userBookId: bookId }, fileId, null)
  const saved = await v2Api.putAnnotation(id, write).catch(adopted)
  return toPublicHighlight(remember(saved))
}

async function updateV2(id: string, data: UpdateHighlightData): Promise<PublicHighlight> {
  const row = rows.get(id)
  if (!row) throw new Error('Highlight not loaded')
  const h = toPublicHighlight(row)
  const write = toV2Write({
    userBookId: row.bookId,
    userChapterId: h.userChapterId,
    anchorJson: data.anchorJson ?? h.anchorJson,
    color: data.color ?? row.color,
    selectedText: data.selectedText ?? row.selectedText,
    noteText: data.noteText === undefined ? row.noteText : data.noteText,
  }, row.fileId, row.revision)
  const saved = await v2Api.putAnnotation(id, write).catch(adopted)
  return toPublicHighlight(remember(saved))
}

async function deleteV2(id: string): Promise<void> {
  await v2Api.deleteAnnotation(id)
  rows.delete(id)
}

/** The reader's highlight calls for an upload, switched per call. */
export const userBookHighlightsApi = {
  ...highlightsApi,
  getUserBookHighlights: async (bookId: string) => ((await onV2()) ? listV2(bookId) : highlightsApi.getUserBookHighlights(bookId)),
  createHighlight: async (data: Parameters<typeof highlightsApi.createHighlight>[0]) =>
    ((await onV2()) ? createV2(data) : highlightsApi.createHighlight(data)),
  updateHighlight: async (id: string, data: UpdateHighlightData) => ((await onV2()) ? updateV2(id, data) : highlightsApi.updateHighlight(id, data)),
  deleteHighlight: async (id: string) => ((await onV2()) ? deleteV2(id) : highlightsApi.deleteHighlight(id)),
}
