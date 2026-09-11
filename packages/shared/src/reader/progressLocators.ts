/**
 * The two locators that mean "this book is finished" and "this book is back at the start".
 *
 * <p>They are sentinels, not coordinates: no offset, no chapter, nothing to parse. A reader who
 * marks a book finished has not told us where in the last chapter they are, and inventing an
 * offset to say so would be a lie the resume path then acts on.</p>
 *
 * <p><b>Why they live here.</b> Web's `markAsRead` wrote `{"type":"end"}` and mobile's
 * "mark finished" wrote `scroll:<lastSlug>:0` — the same action on the same kind of book, in two
 * formats, so a book marked finished on the phone reopened at the top of its last chapter and the
 * same book marked finished in the browser did not. Both clients now write these.</p>
 *
 * <p>Mirrored in C# by `McpToolCatalog.EndOfBook` / `StartOfChapter`, which `set_book_progress`
 * writes for exactly the same reason: an assistant knows the chapter, never the scroll offset.</p>
 */

/** Finished. Written with `percent: 1`, which is what the server turns into `CompletedAt`. */
export const PROGRESS_LOCATOR_END = '{"type":"end"}'

/** Back to the beginning — what "mark as unfinished" writes, with `percent: 0`. */
export const PROGRESS_LOCATOR_START = '{"type":"start"}'
