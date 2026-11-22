/**
 * #1426: a book already in the library gets the details its upload left out (title, author, language, description,
 * cover), read from its file by the reader page when it is opened. Once only: a book still on revision 1 (never
 * edited) gets its cover, then one PATCH that takes it to revision 2; after that it is never filled again. Both
 * hosts call it beside the open, never in its way: it never throws.
 */
import * as syncApi from '../api/sync'
import type { Book, PatchBook } from '../api/sync'
import { jpegBytes, type FileDetails } from '../api/upload'
import { clip } from '../reader/textAnchor'
import { bookTitle, titleFromFileName } from './bookTitle'

/** What an upload titled a book from its file name: the whole name (Android), the name without its extension (web before #1427), the cleaned name. */
const fileNameTitles = (name: string) => [clip(name, 500), clip(name.replace(/\.[a-z0-9]+$/i, '').trim() || name, 500), titleFromFileName(name)]

/**
 * The server book with these bytes as its current file, filled from `describe` (the page's read of the open book)
 * when it still needs it. Null when nothing was sent: not found, edited, nothing missing, describe failed, or any error
 * (a `stale_revision` too: someone edited it first). A failed cover stops before the PATCH: the next open tries again.
 */
export async function fillBookMeta(sha256: string, describe: () => Promise<FileDetails | null>): Promise<Book | null> {
  try {
    const sha = sha256.toLowerCase()
    const book = await syncApi.findBySha256(sha)
    const file = book?.currentFile
    if (!book || book.revision !== 1 || book.removedAt || file?.sha256.toLowerCase() !== sha) return null
    const defaultTitle = fileNameTitles(file.originalName).includes(book.title)
    if (!defaultTitle && book.author && book.language && book.description && book.hasCover) return null
    const { meta, cover } = (await describe()) ?? {}
    if (!meta) return null
    if (!book.hasCover && cover) await syncApi.putCover(book.id, jpegBytes(cover), 'image/jpeg')
    // Only what is missing; nothing missing but the cover is still one PATCH (an empty one bumps the revision): done for good.
    const patch: PatchBook = { expectedRevision: 1 }
    const title = bookTitle(meta.title, file.originalName)
    if (defaultTitle && title !== book.title) patch.title = title
    if (!book.author && meta.author) patch.author = meta.author
    if (!book.language && meta.lang) patch.language = meta.lang
    if (!book.description && meta.description) patch.description = meta.description
    return await syncApi.patchBook(book.id, patch)
  } catch {
    return null
  }
}
