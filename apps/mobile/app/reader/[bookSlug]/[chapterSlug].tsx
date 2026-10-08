import { useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../src/context/AuthContext'
import { useLanguage } from '../../../src/context/LanguageContext'
import { useToast } from '../../../src/context/ToastContext'
import { Reader } from '../../../src/components/reader/Reader'
import { SessionGate } from '../../../src/components/SessionGate'
import { useEditionReaderSource } from '../../../src/components/reader/useEditionReaderSource'

/**
 * Public-library reader route. Thin wrapper: builds the catalog (edition)
 * runtime and hands it to the shared <Reader>. All reader logic lives in the
 * source hook + <Reader> + <ReaderShell> — one code path shared with the
 * user-book reader.
 *
 * Wrapped in <SessionGate>: opening a book is where an anonymous session
 * is minted, and it has to be settled before this body mounts so
 * `isAuthenticated` is constant for the reader's whole lifetime. If the mint
 * fails or the device is offline, the gate opens anyway and the book is read
 * signed out, from cache.
 */
export default function ReaderScreen() {
  return (
    <SessionGate>
      <EditionReader />
    </SessionGate>
  )
}

function EditionReader() {
  const { bookSlug, chapterSlug } = useLocalSearchParams<{ bookSlug: string; chapterSlug: string }>()
  const { isAuthenticated } = useAuth()
  const { language } = useLanguage()
  const { show: showToast } = useToast()

  const runtime = useEditionReaderSource({
    bookSlug: bookSlug ?? '',
    chapterSlug: chapterSlug ?? '',
    language,
    isAuthenticated,
    showToast,
  })

  return <Reader runtime={runtime} />
}
