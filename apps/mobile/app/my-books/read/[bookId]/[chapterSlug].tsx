import { useState } from 'react'
import { Platform } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import V2ReaderScreen from '../../../../src/components/v2reader/V2ReaderScreen'
import { v2Enabled } from '../../../../src/lib/v2'
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
  // M5 (#1031): with V2 on (the probe's settled answer: read now, never waited for) the V2 reader is the reader, on
  // Android (its only host). Every entry point lands here; the chapter slug is ignored, the book opens at its synced
  // place. Fixed for this mount: a probe settling mid-read never swaps the reader. The legacy branch goes at M6.
  const [v2] = useState(() => Platform.OS === 'android' && v2Enabled())
  if (v2) return <V2ReaderScreen />
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
