/**
 * A file name for a book leaving the app that every platform will accept.
 *
 * The title comes from the upload, which means it comes from whatever the file
 * was called when the reader found it: slashes, colons, quotes, emoji and 300
 * characters of z-library provenance all appear in the real data. A name the
 * filesystem rejects fails the download at the last step, after the bytes are
 * already on the device.
 *
 * Falls back to the book id — always present, always safe — when nothing usable
 * survives the strip.
 */

/**
 * Path separators, the Windows-reserved set, and control characters. Built from
 * a string with `\u` escapes rather than written as a literal, so the control
 * range stays readable (and no raw NUL byte ends up in this file).
 *
 * A hyphen is deliberately absent: half these titles are "Book - Author".
 */
const ILLEGAL_FILENAME_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\\\/:*?"<>|]', 'g')

export function bookFileName(
  title: string | null | undefined,
  bookId: string,
  /** The extension to hand the sharing app, without a dot. Was hardcoded to
   *  `epub` while the only thing leaving was a re-encoded EPUB; a reader now
   *  shares the file they uploaded, which is usually a PDF. */
  extension: string = 'epub',
): string {
  const cleaned = (title ?? '')
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    // Leading dots would hide the file on Unix (and `..` would climb).
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Long enough to stay recognisable, short enough for every filesystem once
    // the extension and a cache path are added.
    .slice(0, 80)
    .trim()

  return `${cleaned || bookId}.${extension}`
}
