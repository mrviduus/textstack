import type { ReactNode } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { t, plural, type Language } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import type { useReaderExitSummary } from '../../hooks/useReaderExitSummary'

interface Props {
  prompt: ReturnType<typeof useReaderExitSummary>['prompt']
  /** Reader theme, not app theme — see ExitCard. */
  barBg: string
  barText: string
  language: Language
  sessionWordCount: number
  onReview: () => void
  onUpload: () => void
  onLater: () => void
  /** The "Discuss this chapter" link under the words card; null hides it. */
  onDiscuss: (() => void) | null
  discussBusy: boolean
}

/** The card shown on leaving the reader, when useReaderExitSummary decided one is due. */
export function ReaderExitPrompt({
  prompt, barBg, barText, language, sessionWordCount, onReview, onUpload, onLater, onDiscuss, discussBusy,
}: Props) {
  const { colors } = useTheme()
  return (
    <>
      {prompt === 'review-words' && (
        <ExitCard
          bg={barBg} fg={barText}
          title={plural(sessionWordCount, 'word', 'words', '{n} {noun} saved')}
          primary={{ label: t(language, 'reader.exitSummary.reviewNow'), onPress: onReview }}
          secondary={{ label: t(language, 'reader.exitSummary.later'), onPress: onLater }}
          footer={onDiscuss ? (
            <TouchableOpacity onPress={onDiscuss} disabled={discussBusy} accessibilityRole="button" hitSlop={8}>
              <Text style={[styles.exitSummaryBtnText, { color: colors.primary }]}>✦ {t(language, 'chapterReview.discussChapter')}</Text>
            </TouchableOpacity>
          ) : null}
        />
      )}

      {/* The ask, once per install: they have just finished a chapter and saved
          words in it, so the mechanic has proved itself and the product's real
          proposition — read the books you already care about — is finally
          something they can judge. Not gated on `canUpload` here on purpose:
          the upload screen owns that policy and states it in its own words. */}
      {prompt === 'own-book' && (
        <ExitCard
          bg={barBg} fg={barText} stacked
          title={plural(sessionWordCount, 'word', 'words', '{n} {noun} saved')}
          primary={{ label: t(language, 'reader.ownBookAsk.cta'), onPress: onUpload }}
          secondary={{ label: t(language, 'reader.ownBookAsk.dismiss'), onPress: onLater }}
        >
          <Text style={[styles.askTitle, { color: barText }]}>{t(language, 'reader.ownBookAsk.title')}</Text>
          <Text style={[styles.askBody, { color: barText + 'B3' }]}>{t(language, 'reader.ownBookAsk.body')}</Text>
        </ExitCard>
      )}
    </>
  )
}

interface ExitAction { label: string; onPress: () => void; disabled?: boolean }

/** The exit prompts' shared card. Follows the READER theme (bg/fg), not the app
 *  theme — it sits over the page just read, and a white card over a dark chapter
 *  is a flashbang. `stacked`: sentence-length labels, full-width buttons, since a
 *  row squeezes them on a narrow phone. */
function ExitCard({ bg, fg, title, titleLines, stacked, primary, secondary, children, footer }: {
  bg: string
  fg: string
  title: string
  titleLines?: number
  stacked?: boolean
  primary: ExitAction
  secondary: ExitAction
  children?: ReactNode
  footer?: ReactNode
}) {
  const { colors } = useTheme()
  const button = (a: ExitAction, fill: string, color: string) => (
    <TouchableOpacity
      style={[styles.exitSummaryBtn, stacked && styles.askBtn, { backgroundColor: fill }]}
      onPress={a.onPress}
      disabled={a.disabled}
      accessibilityRole="button"
    >
      <Text style={[styles.exitSummaryBtnText, stacked && styles.askBtnText, { color }]}>{a.label}</Text>
    </TouchableOpacity>
  )
  return (
    <View style={styles.exitSummaryOverlay}>
      <View style={[styles.exitSummaryCard, stacked && styles.askCard, { backgroundColor: bg }]}>
        <Ionicons name="checkmark-circle" size={40} color={colors.success} />
        <Text style={[styles.exitSummaryText, { color: fg, textAlign: 'center' }]} numberOfLines={titleLines}>{title}</Text>
        {children}
        <View style={stacked ? styles.askButtons : styles.exitSummaryButtons}>
          {button(primary, colors.primary, '#fff')}
          {button(secondary, fg + '15', fg)}
        </View>
        {footer}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  exitSummaryOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 200,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  exitSummaryCard: {
    borderRadius: 16,
    paddingHorizontal: 32,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 8,
  },
  exitSummaryText: {
    fontFamily: fonts.sansMedium,
    fontSize: 18,
  },
  exitSummaryButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  exitSummaryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  // The summary card sizes to its content; the ask has two sentences in it and
  // would otherwise run edge to edge.
  askCard: { maxWidth: 340, marginHorizontal: 24 },
  askTitle: { fontFamily: fonts.sansMedium, fontSize: 17, textAlign: 'center', marginTop: 4 },
  askBody: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  askButtons: { alignSelf: 'stretch', gap: 8, marginTop: 12 },
  askBtn: { alignItems: 'center' },
  askBtnText: { fontSize: 15 },
  exitSummaryBtnText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
})
