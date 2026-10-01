import { useState, type ReactNode } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { router } from 'expo-router'
import { buildChapterDiscussBrief, buildHandoffBrief, type Assistant, type HandoffBook } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useAssistantLauncher } from '../../hooks/useAssistantLauncher'
import { chapterReviewRoute } from '../../lib/chapterReviewLaunch'
import { ConnectAssistantSheet } from './ReviewChapterButton'
import { fonts } from '../../theme/typography'

/**
 * "✦ Assistant ▾" beside Continue Reading (`children`) — the one way from a book screen into the
 * reader's own Claude or ChatGPT. Expands inline under the row (no modal: a second Modal for the
 * connect sheet, opened while the first is dismissing, is unreliable on iOS). ONE Discuss item:
 * the current chapter when there is one (plus "Open review" once it is reviewed), else the whole
 * book — never both. Goes through `useAssistantLauncher`, the same path as the chapter-row Discuss.
 */
interface Props {
  /** Upload: bookId; catalog: editionId + slug. */
  book: HandoffBook
  /** From `currentReviewChapter`; null → Discuss the book instead of the chapter. */
  current: { slug: string; title: string; reviewed: boolean } | null
  /** The Continue / Start Reading button, laid out to the left. */
  children?: ReactNode
}

export function AssistantMenu({ book, current, children }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const launcher = useAssistantLauncher({ eager: false })
  const [open, setOpen] = useState(false)

  const toggle = () => { if (!open) void launcher.prefetch(); setOpen(o => !o) }
  const run = (brief: () => string) => { setOpen(false); void launcher.launch(brief, t('library.assistant.pickTitle')) }

  const chapterBrief = (c: { slug: string; title: string }) => () => buildChapterDiscussBrief({
    title: book.title, author: book.author, bookId: book.bookId, editionId: book.editionId, slug: book.slug,
    chapterSlug: c.slug, chapterTitle: c.title,
  })
  const openReview = (slug: string) => {
    setOpen(false)
    router.push(chapterReviewRoute(book.bookId ? { userBookId: book.bookId } : { editionId: book.editionId ?? '', slug: book.slug ?? '' }, slug))
  }
  const chat = (a: Assistant) => t(a === 'claude' ? 'library.assistant.claude' : 'library.assistant.chatgpt')

  const Item = ({ label, sub, onPress }: { label: string; sub?: string; onPress: () => void }) => (
    <TouchableOpacity style={styles.item} onPress={onPress} accessibilityRole="menuitem" disabled={launcher.busy}>
      <Text style={[styles.itemText, { color: colors.text }]}>{label}</Text>
      {sub ? <Text style={[styles.sub, { color: colors.textSecondary }]} numberOfLines={1}>{sub}</Text> : null}
    </TouchableOpacity>
  )

  return (
    <View>
      <View style={styles.row}>
        {children ? <View style={{ flex: 1 }}>{children}</View> : null}
        <TouchableOpacity
          style={[styles.btn, { borderColor: colors.border, backgroundColor: colors.surface }]}
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={t('library.assistant.button')}
          accessibilityState={{ expanded: open }}
        >
          <Text style={[styles.btnText, { color: colors.text }]}>✦ {t('library.assistant.button')} {open ? '▴' : '▾'}</Text>
        </TouchableOpacity>
      </View>
      {open && (
        <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="menu">
          {current
            ? <Item label={t('library.assistant.reviewCurrent')} sub={current.title} onPress={() => run(chapterBrief(current))} />
            : <Item label={t('library.assistant.discuss')} onPress={() => run(() => buildHandoffBrief(book))} />}
          {current?.reviewed && (
            <Item label={t('library.assistant.openCurrentReview')} sub={current.title} onPress={() => openReview(current.slug)} />
          )}
          {launcher.canSwitch && (
            <View style={[styles.chatRow, { borderTopColor: colors.border }]}>
              <Text style={[styles.sub, { color: colors.textSecondary }]}>{t('library.assistant.chatIn')}</Text>
              {(['claude', 'chatgpt'] as const).map(a => {
                const on = launcher.remembered === a
                return (
                  <TouchableOpacity
                    key={a}
                    onPress={() => launcher.remember(a)}
                    style={[styles.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : 'transparent' }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.chipText, { color: on ? colors.background : colors.text }]}>{chat(a)}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
        </View>
      )}
      <ConnectAssistantSheet visible={launcher.connect} onClose={launcher.closeConnect} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btn: { paddingVertical: 14, paddingHorizontal: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  btnText: { fontSize: 15, fontFamily: fonts.sansMedium },
  panel: { marginTop: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  item: { paddingVertical: 10, paddingHorizontal: 14 },
  itemText: { fontSize: 15, fontFamily: fonts.sansMedium },
  sub: { fontSize: 12, fontFamily: fonts.sans, marginTop: 2 },
  chatRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth },
  chip: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  chipText: { fontSize: 13, fontFamily: fonts.sansMedium },
})
