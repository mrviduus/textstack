import { Platform } from 'react-native'
import { isTokenExpiring } from '@textstack/shared'
import { API_URL, getAccessToken, onUnauthorized } from './api'
import { epubFileName } from './epubFileName'

/**
 * Download an uploaded book as EPUB and hand it to the system share sheet.
 *
 * **The bug this replaces.** The button used to call
 * `Linking.openURL('<api>/me/books/<id>/export/epub')`, which opens the system
 * browser — a different process, with none of the app's credentials. The
 * endpoint requires a Bearer token (`UserBooksEndpoints.ExportEpub` →
 * `Results.Unauthorized()`), so every tap landed on a 401. It could never have
 * worked: there is no cookie to fall back on, mobile has never had one.
 *
 * So the fetch happens in-process, with the token attached, and the resulting
 * file is offered through the share sheet — which is also the only way the
 * reader can get it into iBooks, Drive or a mail draft.
 */
export type EpubExportOutcome =
  /** Handed to the share sheet. Whether the user then saved it is their business. */
  | { status: 'shared' }
  /** Downloaded, but this device has no share sheet. The file is at `uri`. */
  | { status: 'saved'; uri: string }
  /** No usable session — a signed-out reader, or a refresh that failed. */
  | { status: 'unauthorized' }
  /** Reached the server, got no book — deleted, or still processing. */
  | { status: 'notfound' }
  | { status: 'failed' }

/** Smaller than any real EPUB: a zip's end-of-central-directory record alone is
 *  22 bytes, and our export always carries a mimetype entry and a spine. A file
 *  under this is an error body that arrived with a 200-shaped download. */
const MIN_PLAUSIBLE_EPUB_BYTES = 256

async function freshToken(): Promise<string | null> {
  const token = await getAccessToken()
  // Refresh BEFORE spending it rather than after a 401: the download API
  // reports failures as a thrown error with no status, so a 401 here is
  // indistinguishable from the device being offline. See tokenExpiry.ts.
  if (token && !isTokenExpiring(token)) return token
  return onUnauthorized()
}

export async function downloadUserBookEpub(
  bookId: string,
  title: string | null,
): Promise<EpubExportOutcome> {
  // Native only, and required lazily for the same reason `offlineDb` requires
  // expo-sqlite lazily: this app also builds for web (the e2e suite runs
  // against it), and a filesystem module at the top of a screen's import graph
  // is a bundling risk for no gain — there is no EPUB export on web.
  if (Platform.OS === 'web') return { status: 'failed' }
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  const Sharing = require('expo-sharing') as typeof import('expo-sharing')

  const token = await freshToken()
  if (!token) return { status: 'unauthorized' }

  const destination = new File(Paths.cache, epubFileName(title, bookId))
  let downloaded: InstanceType<typeof File>
  try {
    downloaded = await File.downloadFileAsync(
      `${API_URL}/me/books/${bookId}/export/epub`,
      destination,
      { headers: { Authorization: `Bearer ${token}` }, idempotent: true },
    )
  } catch (err) {
    console.warn('EPUB download failed:', err)
    return { status: 'failed' }
  }

  // A non-2xx can still land here as a written file (an empty body for a 401, a
  // JSON error for a 404), so the size is the only honest check available.
  let size = 0
  try {
    size = downloaded.size ?? 0
  } catch {
    size = 0
  }
  if (size < MIN_PLAUSIBLE_EPUB_BYTES) {
    try { downloaded.delete() } catch { /* best effort */ }
    return { status: 'notfound' }
  }

  if (!(await Sharing.isAvailableAsync())) {
    return { status: 'saved', uri: downloaded.uri }
  }

  try {
    await Sharing.shareAsync(downloaded.uri, {
      mimeType: 'application/epub+zip',
      // iOS routes by UTI, and without this one the sheet offers no EPUB reader.
      UTI: 'org.idpf.epub-container',
      dialogTitle: title ? `Save "${title}"` : 'Save EPUB',
    })
    return { status: 'shared' }
  } catch (err) {
    // The user dismissing the sheet also rejects on some Android builds, which
    // is not an error worth reporting — but the file IS on the device either
    // way, so say where it is rather than claiming a failure.
    console.warn('EPUB share sheet failed:', err)
    return { status: 'saved', uri: downloaded.uri }
  }
}
