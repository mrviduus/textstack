import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { fonts } from '../../theme/typography'

type Props = {
  barBg: string
  barText: string
  barsAnim: Animated.Value
  topBarTranslateY: Animated.AnimatedInterpolation<number>
  barsVisible: boolean
  topInset: number
  bookTitle: string
  chapterTitle: string
  sessionWordCount: number
  isAuthenticated: boolean
  hasChapters: boolean
  isCurrentBookmarked: boolean
  onExit: () => void
  onBookmarksPress: () => void
  onHighlightsPress: () => void
  onTocPress: () => void
  onSettingsPress: () => void
}

/**
 * Reader's top chrome — back button, title stack, words-saved badge,
 * bookmarks/TOC/settings actions. Absolute overlay, slides down driven
 * by the parent's bars animation (immersive auto-hide on scroll).
 */
export function ReaderTopBar({
  barBg,
  barText,
  barsAnim,
  topBarTranslateY,
  barsVisible,
  topInset,
  bookTitle,
  chapterTitle,
  sessionWordCount,
  isAuthenticated,
  hasChapters,
  isCurrentBookmarked,
  onExit,
  onBookmarksPress,
  onHighlightsPress,
  onTocPress,
  onSettingsPress,
}: Props) {
  return (
    <Animated.View
      style={[
        styles.topBar,
        { backgroundColor: barBg, paddingTop: topInset, opacity: barsAnim, transform: [{ translateY: topBarTranslateY }] },
      ]}
      pointerEvents={barsVisible ? 'auto' : 'none'}
    >
      <TouchableOpacity onPress={onExit} style={styles.topBarBtn}>
        <Ionicons name="chevron-back" size={24} color={barText} />
      </TouchableOpacity>
      <View style={styles.titleStack}>
        {bookTitle ? (
          <Text style={[styles.bookTitle, { color: barText }]} numberOfLines={1}>{bookTitle}</Text>
        ) : null}
        <Text style={[styles.chapterTitle, { color: barText + '99' }]} numberOfLines={1}>
          {chapterTitle}
        </Text>
      </View>
      {sessionWordCount > 0 && (
        <View style={styles.wordsBadge}>
          <Ionicons name="school" size={12} color="#10B981" />
          <Text style={styles.wordsBadgeText}>{sessionWordCount}</Text>
        </View>
      )}
      <View style={styles.topBarRight}>
        {isAuthenticated && (
          <TouchableOpacity onPress={onBookmarksPress} style={styles.iconBtn}>
            <Ionicons name={isCurrentBookmarked ? 'bookmark' : 'bookmark-outline'} size={20} color={barText} />
          </TouchableOpacity>
        )}
        {isAuthenticated && (
          <TouchableOpacity onPress={onHighlightsPress} style={styles.iconBtn} accessibilityLabel="Highlights">
            <Ionicons name="color-wand-outline" size={20} color={barText} />
          </TouchableOpacity>
        )}
        {hasChapters && (
          <TouchableOpacity onPress={onTocPress} style={styles.iconBtn}>
            <Ionicons name="list-outline" size={20} color={barText} />
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={onSettingsPress} style={styles.iconBtn}>
          <Ionicons name="options-outline" size={20} color={barText} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  topBarBtn: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  titleStack: { flex: 1, marginHorizontal: 8 },
  bookTitle: { fontSize: 14, fontWeight: '600', fontFamily: fonts.sansMedium },
  chapterTitle: { fontSize: 12, fontFamily: fonts.sans },
  topBarRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconBtn: { padding: 8, minWidth: 40, minHeight: 40, justifyContent: 'center', alignItems: 'center', borderRadius: 4 },
  wordsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(16,185,129,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  wordsBadgeText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: '#10B981',
  },
})
