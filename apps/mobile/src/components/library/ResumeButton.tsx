import { Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native'
import { useCallback, useRef, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { userBooksApi } from '@textstack/shared'
import type { ContinueReadingPick } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { resumeUploadRoute } from '../../lib/bookRoutes'
import { keyOfPick } from '../../lib/continueRow'
import { getCachedUserBookMeta, listCachedUserChapterPages, storeCachedUserChapterStartPages } from '../../lib/offlineDb'

/**
 * One instance for the whole Library: the lookup guard, the focus guard and the router live here,
 * not in every row. One chapter-list lookup at a time (RES-1); taps while it runs are ignored.
 */
export function useResume() {
  const router = useRouter()
  const busyRef = useRef(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  // A lookup that resolves after the reader left the Library (or the list unmounted) must not navigate.
  const focusedRef = useRef(true)
  useFocusEffect(useCallback(() => {
    focusedRef.current = true
    return () => { focusedRef.current = false }
  }, []))
  const open = async (pick: ContinueReadingPick) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyKey(keyOfPick(pick))
    try {
      const route = await resumeUploadRoute(pick, {
        device: async id => {
          const [chapters, meta] = await Promise.all([listCachedUserChapterPages(id), getCachedUserBookMeta(id)])
          return { chapters, totalChapters: meta?.totalChapters ?? 0 }
        },
        server: id => userBooksApi.getUserBook(id).then(b => b.chapters),
        remember: storeCachedUserChapterStartPages,
      })
      if (focusedRef.current) router.push(route as never)
    } finally {
      busyRef.current = false
      setBusyKey(null)
    }
  }
  return { open, busyKey }
}

/**
 * Continue on a Library row or grid cover. The Library used to open on a hero card with
 * the same book as row one; the row now carries the action itself.
 *
 * It links straight into the reader at the last chapter, not to the book
 * detail page. A detail page is a second decision the user did not ask for.
 * `filled` marks the first visible Continue; the rest are quiet outlines. `compact` (grid cover badge) is always solid, since an outline does not read over a cover.
 */
export function ResumeButton({ pick, filled: wantFilled, compact, onResume, busyKey }: {
  pick: ContinueReadingPick
  filled: boolean
  compact?: boolean
  onResume: (pick: ContinueReadingPick) => void
  busyKey: string | null
}) {
  const filled = wantFilled || !!compact
  const { colors } = useTheme()
  const { t } = useLanguage()
  const busy = busyKey === keyOfPick(pick)

  const percent = Math.round(pick.percent * 100)
  const fg = filled ? '#fff' : colors.primary

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t('library.resume.a11yResume')
        .replace('{title}', pick.title)
        .replace('{percent}', String(percent))}
      accessibilityState={{ busy }}
      hitSlop={8}
      onPress={() => onResume(pick)}
      style={[styles.cta, compact && styles.compact, filled ? { backgroundColor: colors.primary } : { borderWidth: 1, borderColor: colors.primary }]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Ionicons name="play" size={12} color={fg} />}
      {!compact && <Text style={[styles.ctaText, { color: fg }]}>{t('library.resume.continue')}</Text>}
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  // Grid cover badge: icon only, solid so it reads over any cover.
  compact: { width: 30, height: 30, justifyContent: 'center', paddingVertical: 0, paddingHorizontal: 0, borderRadius: 15 },
  ctaText: { fontFamily: fonts.sansMedium, fontSize: 13 },
})
