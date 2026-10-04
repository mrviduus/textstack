/**
 * The first thing a person who has never read here sees: one line saying what
 * this app is, and one tap into a real chapter.
 *
 * Why it exists: on install you land on Discover — a search box, three stat
 * chips and a grid of covers. Nothing on that screen says what the product is
 * or why to read here rather than in any other reader. The thing that makes it
 * different is a gesture (long-press a word → translated in place → save →
 * review), and that gesture is taught by a coachmark that only fires INSIDE the
 * reader — i.e. only after you have picked one book out of 1,354, which is work
 * rather than a gift for someone who does not yet know what the app does.
 *
 * Web solved this with `HeroSection` + `config/demoBook.ts`; this is the mobile
 * half, pointed at the same chapter.
 *
 * Self-contained, following `ReaderTapCoachmark`: the screen renders it
 * unconditionally and this component decides whether to be visible. The
 * decision itself is `decideStartReadingCard` in `src/lib/firstRun.ts`, where
 * it can be tested — everything here is layout.
 */

import { useCallback, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { demoBookRoute } from '../../lib/demoBook'
import { decideStartReadingCard, START_READING_DISMISSED_KEY } from '../../lib/firstRun'
import {
  getAllLocalProgress, getAllUserBookLocalProgress,
  type LocalProgress, type UserBookProgressWithPercent,
} from '../../lib/progressStorage'

export function StartReadingCard() {
  const router = useRouter()
  const { colors } = useTheme()
  const { t } = useLanguage()
  // `null` until AsyncStorage answers — `decideStartReadingCard` turns that
  // into "render nothing", which is not the same answer as "show the card".
  const [fractions, setFractions] = useState<number[] | null>(null)
  const [dismissed, setDismissed] = useState(false)

  // On FOCUS, not on mount: Discover is a tab screen that never unmounts, so a
  // mount-only read would leave the card sitting there after the reader had
  // been used and come back.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      ;(async () => {
        // Read independently — a corrupt row in one store must not blank the
        // other half of the answer (same reasoning as useContinueReadingList).
        const [catalog, userBooks, dismissedFlag] = await Promise.all([
          getAllLocalProgress().catch(() => new Map<string, LocalProgress>()),
          getAllUserBookLocalProgress().catch(() => new Map<string, UserBookProgressWithPercent>()),
          // A failed read counts as "not closed": showing the card once more is
          // cheaper than hiding it from someone it was never shown to.
          AsyncStorage.getItem(START_READING_DISMISSED_KEY).catch(() => null),
        ])
        if (cancelled) return
        if (dismissedFlag === '1') setDismissed(true)
        setFractions([
          // Catalog rows carry both; book-percent is the honest one when it is
          // there, and chapter-percent is all the older rows have.
          ...Array.from(catalog.values(), p => (typeof p.bookPercent === 'number' ? p.bookPercent : p.percent)),
          ...Array.from(userBooks.values(), p => p.bookPercent),
        ])
      })()
      return () => { cancelled = true }
    }, []),
  )

  const decision = decideStartReadingCard({
    loaded: fractions !== null,
    progressFractions: fractions ?? [],
    dismissed,
  })
  if (!decision.show) return null

  const dismiss = () => {
    setDismissed(true)
    AsyncStorage.setItem(START_READING_DISMISSED_KEY, '1').catch(e => console.warn('StartReadingCard dismiss persist failed:', e))
  }

  // The close button is a SIBLING of the card's touchable, not a child: a
  // touchable with an accessibilityLabel collapses its children into one
  // element, which would hide the button from screen readers.
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.primary + '55' }]}
        onPress={() => router.push(demoBookRoute())}
        activeOpacity={0.9}
        accessibilityRole="button"
        accessibilityLabel={t('firstRun.startReading.a11y')}
      >
        <Text style={[styles.title, { color: colors.text }]}>{t('firstRun.startReading.title')}</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>{t('firstRun.startReading.body')}</Text>
        <View style={[styles.ctaRow, { backgroundColor: colors.primary }]}>
          <Ionicons name="book-outline" size={16} color="#fff" />
          <Text style={styles.ctaText}>{t('firstRun.startReading.cta')}</Text>
          <Ionicons name="arrow-forward" size={16} color="#fff" />
        </View>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>{t('firstRun.startReading.meta')}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.close}
        onPress={dismiss}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={t('firstRun.startReading.dismiss')}
      >
        <Ionicons name="close" size={20} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 12, marginTop: 12 },
  card: {
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  // paddingRight keeps a long title clear of the close button.
  title: { fontFamily: fonts.serifBold, fontSize: 20, lineHeight: 26, paddingRight: 28 },
  close: { position: 'absolute', top: 10, right: 10, padding: 4 },
  body: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, marginTop: 8 },
  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 999,
  },
  ctaText: { fontFamily: fonts.sansMedium, fontSize: 15, color: '#fff' },
  meta: { fontFamily: fonts.sans, fontSize: 12, textAlign: 'center', marginTop: 8 },
})
