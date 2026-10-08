import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { createBooksApi, readingProgressApi, userBooksApi } from '@textstack/shared'
import { useLanguage } from '../context/LanguageContext'
import { createResumeOpener } from '../lib/resumeOpener'
import { resolveResumeRoute } from '../lib/resumeTarget'

/**
 * Continue, the same way everywhere a book can be resumed from (Library hero and list).
 * `pendingKey` is the pick being looked up, for a spinner — see `resumePickKey`.
 */
export function useResumeOpener() {
  const router = useRouter()
  const { language } = useLanguage()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const activeRef = useRef(true)
  useFocusEffect(useCallback(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, []))
  useEffect(() => () => { activeRef.current = false }, [])

  const open = useMemo(() => createResumeOpener({
    resolve: pick => resolveResumeRoute(pick, {
      getEdition: slug => createBooksApi(language).getBook(slug),
      getEditionProgress: id => readingProgressApi.getProgress(id),
      getUserBook: id => userBooksApi.getUserBook(id),
      getUserBookProgress: id => userBooksApi.getUserBookProgress(id),
    }),
    push: route => router.push(route as never),
    isActive: () => activeRef.current,
    onPending: key => { if (activeRef.current || key === null) setPendingKey(key) },
  }), [language, router])

  return { open, pendingKey }
}
