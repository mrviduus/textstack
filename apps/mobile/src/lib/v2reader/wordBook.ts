/**
 * A word saved from the open book, with that book's id (#1303). The id comes from memory (the library list), so a
 * tap waits on no storage; a sync can re-key the book after the list was read, so the server's `book_not_found`
 * asks the row once (`resolve`, by the book's bytes) and a different id is tried once. A book still unknown (not
 * synced yet), or no id at all: the word is saved without it.
 */
export async function saveWordForBook<T>(
  bookId: string | null,
  deps: {
    save: (bookId: string | null) => Promise<T>
    resolve: () => Promise<string | null>
    isNotFound: (e: unknown) => boolean
  },
): Promise<T> {
  const { save, resolve, isNotFound } = deps
  const tryWith = async (id: string | null): Promise<{ saved: T } | null> => {
    try {
      return { saved: await save(id) }
    } catch (e) {
      if (isNotFound(e)) return null
      throw e
    }
  }
  const first = await tryWith(bookId)
  if (first) return first.saved
  const now = await resolve().catch((e: unknown) => {
    console.warn('[v2] open book id not resolved:', e)
    return null
  })
  const second = now && now !== bookId ? await tryWith(now) : null
  return second ? second.saved : save(null)
}
