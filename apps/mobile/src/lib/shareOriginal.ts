import { Platform } from 'react-native'
import { APP_HEADERS, freshAccessToken } from './api'
import { bookFileName } from './bookFileName'
import { retainedFile } from './reader/deviceDownload'
import { shareTypeOf } from './originalFilePolicy'
import { syncStore } from './sync'
import { userBooksApi } from './userBooksApi'

/**
 * Hand the reader back the file they uploaded.
 *
 * **What this replaces.** The button used to call the owner-scoped EPUB-export
 * route (deleted with this change), which built a *new* EPUB out of the
 * extracted text — no images, and for a PDF upload no images exist at all (ADR-012 dropped inline extraction, because "the
 * PDF renders its own images" — true only while the PDF is the thing being
 * rendered). So the app held the reader's own 40 MB illustrated PDF on disk,
 * byte for byte, and the button beside it offered a text-only re-encoding of it
 * under the name "Download EPUB". Of the two downloads, the one named more
 * clearly gave back the worse book.
 *
 * Now it gives back the original, and **when the book is already downloaded it
 * never touches the network** — the file is on the device; asking the server for
 * it again would be the same absurdity the offline work exists to remove.
 *
 * The copy into the cache directory is only about the name: the retained file
 * is `books/<sha256>.epub` whatever its format (#1527), and a share sheet shows the file name to whatever app
 * receives it. A local copy is cheap and costs no data; re-downloading to get a
 * nicer name would not be.
 */
export type ShareOriginalOutcome =
  /** Handed to the share sheet. Whether the reader then saved it is their business. */
  | { status: 'shared' }
  /** Ready on the device, but this device has no share sheet. The file is at `uri`. */
  | { status: 'saved'; uri: string }
  /** Not on the device and no usable session to fetch it with. */
  | { status: 'unauthorized' }
  /** Reached the server, got no file — deleted, taken down, or still uploading. */
  | { status: 'notfound' }
  | { status: 'failed' }

/** Smaller than any real document: a PDF's header and trailer alone exceed this,
 *  and an EPUB carries a zip directory plus a mimetype entry. A non-2xx body can
 *  still land as a written file, so size is the only honest check available
 *  without hashing twenty megabytes on the device. */
const MIN_PLAUSIBLE_BYTES = 1024

export async function shareOriginalFile(
  bookId: string,
  title: string | null,
): Promise<ShareOriginalOutcome> {
  // Native only, required lazily: this app also builds for web (the e2e suite runs against it) and there is no
  // file sharing there.
  if (Platform.OS === 'web') return { status: 'failed' }
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  const Sharing = require('expo-sharing') as typeof import('expo-sharing')

  // The Download (#1527): offline, a downloaded book shares from the device and never asks for a token.
  const cached = await retainedFile(bookId).catch(() => null)
  // The file's real format (#1553): the device's, else the last library pull's.
  const { extension, mimeType, uti } = shareTypeOf(cached?.format ?? syncStore.books.get(bookId)?.currentFile?.format)
  const destination = new File(Paths.cache, bookFileName(title, bookId, extension))
  // A leftover from a previous share would otherwise be handed out again — and
  // `copy` onto an existing path fails rather than overwriting.
  try {
    if (destination.exists) destination.delete()
  } catch { /* best effort — the copy or download below will report the real problem */ }

  if (cached) {
    try {
      // Async (a Promise): unawaited, the size check below read an empty file and said "not found".
      await new File(cached.uri).copy(destination)
    } catch (err) {
      console.warn('[share] local copy failed:', err)
      return { status: 'failed' }
    }
  } else {
    // The legacy route, or V2's content route; '' = a V2 book whose file is not known yet.
    const url = userBooksApi.getUserBookFileUrl(bookId)
    if (!url) return { status: 'failed' }
    const token = await freshAccessToken()
    if (!token) return { status: 'unauthorized' }
    try {
      await File.downloadFileAsync(
        url,
        destination,
        { headers: { ...APP_HEADERS, Authorization: `Bearer ${token}` }, idempotent: true },
      )
    } catch (err) {
      console.warn('[share] original download failed:', err)
      return { status: 'failed' }
    }
  }

  let size = 0
  try {
    size = destination.size ?? 0
  } catch {
    size = 0
  }
  if (size < MIN_PLAUSIBLE_BYTES) {
    try { destination.delete() } catch { /* best effort */ }
    return { status: 'notfound' }
  }

  if (!(await Sharing.isAvailableAsync())) {
    return { status: 'saved', uri: destination.uri }
  }

  try {
    await Sharing.shareAsync(destination.uri, {
      mimeType,
      UTI: uti,
      dialogTitle: title ? `Share "${title}"` : 'Share book file',
    })
    return { status: 'shared' }
  } catch (err) {
    // Dismissing the sheet also rejects on some Android builds, which is not a
    // failure worth reporting — and the file is on the device either way, so
    // say where it is rather than claiming it went wrong.
    console.warn('[share] share sheet failed:', err)
    return { status: 'saved', uri: destination.uri }
  }
}
