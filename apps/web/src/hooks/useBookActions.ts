import { useCallback, useState } from 'react'
import {
  cancelUserBook,
  deleteUserBook,
  markUserBookComplete,
  retryUserBook,
  unmarkUserBookComplete,
  type UserBook,
} from '../api/userBooks'
import { emitDataChanges } from '../lib/dataEvents'

interface Options {
  onChange?: () => void
  onDelete?: () => void
}

export function useBookActions(book: UserBook, opts: Options = {}) {
  const [pending, setPending] = useState<null | 'mark' | 'retry' | 'cancel' | 'delete'>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (
    kind: 'mark' | 'retry' | 'cancel' | 'delete',
    fn: () => Promise<unknown>,
    after?: () => void,
  ) => {
    if (pending) return
    setPending(kind)
    setError(null)
    try {
      // Signed out meanwhile: the write never landed, nothing to refresh.
      if ((await fn()) === 'dropped') return
      // Any user-book mutation also affects the cached shelves (recently
      // added / continue reading / quick reads). Broadcast both so every
      // consumer (LibraryPage, sidebar counts, shelves cache) refreshes.
      emitDataChanges(['user-books', 'shelves'])
      after?.()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed'
      setError(msg)
      console.error(`[useBookActions] ${kind} failed:`, err)
    } finally {
      setPending(null)
    }
  }, [pending])

  const markFinished = useCallback(() => {
    return run('mark', () => markUserBookComplete(book.id), opts.onChange)
  }, [book.id, opts.onChange, run])

  const markUnfinished = useCallback(() => {
    return run('mark', () => unmarkUserBookComplete(book.id), opts.onChange)
  }, [book.id, opts.onChange, run])

  const retry = useCallback(() => {
    return run('retry', () => retryUserBook(book.id), opts.onChange)
  }, [book.id, opts.onChange, run])

  const cancel = useCallback(() => {
    return run('cancel', () => cancelUserBook(book.id), opts.onChange)
  }, [book.id, opts.onChange, run])

  const remove = useCallback(() => {
    return run('delete', () => deleteUserBook(book.id), opts.onDelete ?? opts.onChange)
  }, [book.id, opts.onChange, opts.onDelete, run])

  return {
    markFinished,
    markUnfinished,
    retry,
    cancel,
    remove,
    pending,
    error,
    isLoading: pending !== null,
  }
}
