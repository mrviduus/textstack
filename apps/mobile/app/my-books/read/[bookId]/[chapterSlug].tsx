import { useLocalSearchParams } from 'expo-router'
import { useToast } from '../../../../src/context/ToastContext'
import { Reader } from '../../../../src/components/reader/Reader'
import { SessionGate } from '../../../../src/components/SessionGate'
import { useUserBookReaderSource } from '../../../../src/components/reader/useUserBookReaderSource'

/**
 * User-uploaded book reader route. Thin wrapper: builds the user-book runtime
 * and hands it to the shared <Reader>. Identical code path to the catalog
 * reader — the only difference (data fetch + progress I/O) lives behind the
 * source hook.
 *
 * Gated identically to the catalog route. This route reads no `isAuthenticated`
 * of its own, but the hooks under it do (`useReaderVocabMap` keys two effects
 * on it), so the same mid-mount refetch applies — and a user book is by
 * definition already tied to a session that must be settled before the reader
 * starts writing progress against it.
 */
export default function UserBookReaderScreen() {
  return (
    <SessionGate>
      <UserBookReader />
    </SessionGate>
  )
}

function UserBookReader() {
  const { bookId, chapterSlug, pick } = useLocalSearchParams<{ bookId: string; chapterSlug: string; pick?: string }>()
  const { show: showToast } = useToast()

  const runtime = useUserBookReaderSource({
    bookId: bookId ?? '',
    chapterSlug: chapterSlug ?? '',
    showToast,
    chapterPicked: pick === '1',
  })

  return <Reader runtime={runtime} />
}
