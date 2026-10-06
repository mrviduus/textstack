import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native'
import { fonts } from '../../theme/typography'

interface Props {
  barBg: string
  barText: string
  /** Progress bar track. */
  trackColor: string
  barsAnim: Animated.Value
  footerTranslateY: Animated.AnimatedInterpolation<number>
  barsVisible: boolean
  bottomInset: number
  bookProgress: number | null
  chapterTitle: string
  /** Index of the active chapter in the list, -1 when not found. */
  currentChapterIndex: number
  totalChapters: number
  timeLeftLabel: string | null
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  /** The footer's measured height, rounded — it grows a line with the time-left label. */
  onHeight: (height: number) => void
}

/** The reflow reader's footer: book progress bar, chapter chevrons, title, counter, % and time left. */
export function ReaderFooter({
  barBg, barText, trackColor, barsAnim, footerTranslateY, barsVisible, bottomInset, bookProgress,
  chapterTitle, currentChapterIndex, totalChapters, timeLeftLabel, hasPrev, hasNext, onPrev, onNext, onHeight,
}: Props) {
  return (
    <Animated.View
      onLayout={e => onHeight(Math.round(e.nativeEvent.layout.height))}
      style={[
        styles.footer,
        {
          backgroundColor: barBg,
          borderTopColor: barText + '15',
          paddingBottom: bottomInset,
          opacity: barsAnim,
          transform: [{ translateY: footerTranslateY }],
          // Android draws elevation from the native outline provider, which
          // does not follow an animated opacity — so the shadow survived the
          // fade and sat on the text as a dark line. Drop it while hidden.
          elevation: barsVisible ? 2 : 0,
          borderTopWidth: barsVisible ? StyleSheet.hairlineWidth : 0,
        },
      ]}
      pointerEvents={barsVisible ? 'auto' : 'none'}
    >
      <View style={[styles.progressBar, { backgroundColor: trackColor }]}>
        <View style={[styles.progressFill, { width: `${bookProgress != null ? Math.round(bookProgress * 100) : 0}%`, backgroundColor: barText + '40' }]} />
      </View>
      <View style={styles.footerRow}>
        <TouchableOpacity
          onPress={onPrev}
          disabled={!hasPrev}
          style={styles.chevronBtn}
          accessibilityLabel="Previous chapter"
          accessibilityRole="button"
        >
          <Text style={[styles.chevron, { color: barText + (hasPrev ? 'CC' : '40') }]}>‹</Text>
        </TouchableOpacity>

        <View style={styles.footerInfo}>
          <Text style={[styles.footerChapter, { color: barText }]} numberOfLines={1}>
            {chapterTitle}
          </Text>
          <View style={styles.footerMeta}>
            {totalChapters > 1 && currentChapterIndex >= 0 && (
              <Text style={[styles.footerCounter, { color: barText + '99' }]}>
                {currentChapterIndex + 1} / {totalChapters}
              </Text>
            )}
            <Text style={[styles.footerPercent, { color: barText + '99' }]}>
              {bookProgress != null ? `${Math.round(bookProgress * 100)}%` : '—'}
            </Text>
          </View>
          {timeLeftLabel ? (
            <Text style={[styles.footerTimeLeft, { color: barText + '99' }]} numberOfLines={1}>
              {timeLeftLabel}
            </Text>
          ) : null}
        </View>

        <TouchableOpacity
          onPress={onNext}
          disabled={!hasNext}
          style={styles.chevronBtn}
          accessibilityLabel="Next chapter"
          accessibilityRole="button"
        >
          <Text style={[styles.chevron, { color: barText + (hasNext ? 'CC' : '40') }]}>›</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    // borderTopWidth and elevation are applied inline — both have to disappear
    // when the bar hides, and neither follows an animated opacity on Android.
  },
  footerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 4, minHeight: 48 },
  chevronBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  chevron: { fontSize: 28, fontFamily: fonts.sans, lineHeight: 28 },
  footerInfo: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  footerChapter: { fontSize: 13, fontFamily: fonts.sansMedium, fontWeight: '500' as const, textAlign: 'center' },
  footerMeta: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  footerCounter: { fontSize: 11, fontFamily: fonts.sans, fontVariant: ['tabular-nums'] },
  footerTimeLeft: { fontFamily: fonts.sans, fontSize: 11, marginTop: 2 },
  footerPercent: { fontSize: 11, fontFamily: fonts.sans, fontVariant: ['tabular-nums'] },
  progressBar: { height: 4, borderRadius: 0 },
  progressFill: { height: 4, borderRadius: 0 },
})
