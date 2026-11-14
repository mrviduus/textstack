/**
 * A word saved from the open book, with that book's id (#1303); resolves to the answer and the id it went with.
 * The id comes from memory (the library list), so a tap waits on no storage; with none there (the list not
 * refreshed yet) the row is asked once (`resolve`, by the book's bytes). A sync can re-key the book after the list
 * was read, so the server's `book_not_found` asks the row once and a different id is tried once. A book still
 * unknown (not synced yet), or no id at all: the word is saved without it.
 *
 * ponytail: a book the server does not have yet costs a 404 and a row read on every tap; remember "unknown to the
 * server" per session if that matters.
 */
export async function saveWordForBook<T>(
  bookId: string | null,
  deps: {
    save: (bookId: string | null) => Promise<T>
    resolve: () => Promise<string | null>
    isNotFound: (e: unknown) => boolean
  },
): Promise<{ saved: T; bookId: string | null }> {
  const { save, resolve, isNotFound } = deps
  const tryWith = async (id: string | null) => {
    try {
      return { saved: await save(id), bookId: id }
    } catch (e) {
      if (isNotFound(e)) return null
      throw e
    }
  }
  const lookup = () => resolve().catch((e: unknown) => {
    console.warn('[v2] open book id not resolved:', e)
    return null
  })
  const first = bookId ?? (await lookup())
  const done = await tryWith(first)
  if (done) return done
  // Only an id from memory can be stale: one just read from the row is what a lookup would answer again.
  const now = bookId ? await lookup() : null
  const retried = now && now !== first ? await tryWith(now) : null
  return retried ?? { saved: await save(null), bookId: null }
}
