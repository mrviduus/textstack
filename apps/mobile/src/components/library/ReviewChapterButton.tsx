import { useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Linking, Alert, Modal, Pressable } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import {
  MCP_ENDPOINT, buildChapterReviewBrief, chooseChat, connectedAssistants, handoffUrl, isReviewableChapter, oauthGrantsApi,
  type Assistant, type ChapterReviewBriefInput, type OAuthGrant,
} from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useToast } from '../../context/ToastContext'
import { useAuth } from '../../context/AuthContext'
import { capabilitiesFor } from '../../lib/capabilities'
import {
  chapterReviewRoute, loadGrantsCached, loadReviewAssistant, resetGrantsCache, saveReviewAssistant, type ReviewBookRef,
} from '../../lib/chapterReviewLaunch'
import { fonts } from '../../theme/typography'

/**
 * "Review" — opens the reader's own Claude or ChatGPT with a chapter-review brief
 * (docs/05-features/chapter-review.md §12). One assistant connected → straight there; both → the
 * remembered one (a native two-button choice the first time), with a chevron beside the button to
 * switch — the new pick is remembered on this device; none → a connect sheet, never a chat that
 * cannot reach TextStack. A failed `Linking.openURL` is surfaced (handoff TODO #10), not swallowed.
 *
 * Grants come from one cached request shared by every button (`loadGrantsCached`).
 */
interface Props extends ChapterReviewBriefInput {
  label?: string
  /** Larger, filled style (summary screen); the default is the small chapter-row pill. */
  primary?: boolean
}

export function ReviewChapterButton({ label, primary, ...input }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { show: showToast } = useToast()
  const { user } = useAuth()
  const { canConnectAssistant } = capabilitiesFor(user)
  const [connect, setConnect] = useState(false)
  const [busy, setBusy] = useState(false)
  const [grants, setGrants] = useState<OAuthGrant[]>([])

  // A guest cannot connect an assistant (account-only), so it has none — skip the 403.
  const fetchGrants = () => canConnectAssistant
    ? loadGrantsCached(oauthGrantsApi.listOAuthGrants)
    : Promise.resolve([] as OAuthGrant[])

  useEffect(() => {
    let live = true
    void fetchGrants().then(g => { if (live) setGrants(g) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConnectAssistant])
  const canSwitch = connectedAssistants(grants).length === 2

  const open = (assistant: Assistant) => {
    Linking.openURL(handoffUrl(assistant, buildChapterReviewBrief(input))).catch(() => {
      showToast({ message: t('chapterReview.openFailed'), variant: 'error' })
    })
  }

  const choose = () => {
    const pick = (a: Assistant) => { void saveReviewAssistant(a); open(a) }
    Alert.alert(t('chapterReview.pickTitle'), undefined, [
      { text: t('library.discuss.claude'), onPress: () => pick('claude') },
      { text: t('library.discuss.chatgpt'), onPress: () => pick('chatgpt') },
      { text: t('chapterReview.connect.close'), style: 'cancel' },
    ])
  }

  const onPress = async () => {
    if (busy) return
    setBusy(true)
    try {
      const choice = chooseChat(await fetchGrants(), await loadReviewAssistant())
      if (choice.kind === 'open') open(choice.assistant)
      else if (choice.kind === 'none') { resetGrantsCache(); setConnect(true) }
      else choose()
    } finally {
      setBusy(false)
    }
  }

  const text = label ?? t('chapterReview.review')
  return (
    <View style={[styles.row, primary && styles.rowPrimary]}>
      <TouchableOpacity
        onPress={onPress}
        disabled={busy}
        style={[
          primary ? [styles.primary, { flex: 1 }] : styles.pill,
          primary ? { backgroundColor: colors.primary } : { borderColor: colors.border, backgroundColor: colors.surface },
        ]}
        accessibilityRole="button"
        accessibilityLabel={label ?? t('chapterReview.reviewAria').replace('{{title}}', input.chapterTitle)}
      >
        <Text style={[primary ? styles.primaryText : styles.pillText, { color: primary ? colors.background : colors.text }]}>{text}</Text>
      </TouchableOpacity>
      {canSwitch && (
        <TouchableOpacity
          onPress={choose}
          style={[styles.switch, { borderColor: colors.border, backgroundColor: primary ? 'transparent' : colors.surface }]}
          accessibilityRole="button"
          accessibilityLabel={t('chapterReview.switchAria')}
          hitSlop={6}
        >
          <Ionicons name="chevron-down" size={primary ? 18 : 12} color={colors.textSecondary} />
        </TouchableOpacity>
      )}
      <ConnectAssistantSheet visible={connect} onClose={() => setConnect(false)} />
    </View>
  )
}

/** Nothing connected: the connect screen's one-step text, Copy URL, and a way to the full screen. */
export function ConnectAssistantSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { show: showToast } = useToast()

  const copy = async () => {
    await Clipboard.setStringAsync(MCP_ENDPOINT)
    showToast({ message: t('chapterReview.connect.copied'), variant: 'success' })
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('chapterReview.connect.close')} />
      <View style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>{t('chapterReview.connect.title')}</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>{t('chapterReview.connect.lead')}</Text>
        <View style={[styles.urlRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text selectable style={[styles.url, { color: colors.text }]}>{MCP_ENDPOINT}</Text>
          <TouchableOpacity onPress={copy} accessibilityRole="button">
            <Text style={[styles.link, { color: colors.primary }]}>{t('chapterReview.connect.copy')}</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.body, { color: colors.text }]}>
          <Text style={{ fontFamily: fonts.sansMedium }}>{t('connect.oneStep.claudeLabel')}: </Text>
          {t('connect.oneStep.claudeHow')}
        </Text>
        <Text style={[styles.body, { color: colors.text }]}>
          <Text style={{ fontFamily: fonts.sansMedium }}>{t('connect.oneStep.chatgptLabel')}: </Text>
          {t('connect.oneStep.chatgptHow')}
        </Text>
        <View style={styles.sheetActions}>
          <TouchableOpacity onPress={() => { onClose(); router.push('/connect') }} accessibilityRole="link">
            <Text style={[styles.link, { color: colors.primary }]}>{t('chapterReview.connect.more')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} accessibilityRole="button">
            <Text style={[styles.link, { color: colors.textSecondary }]}>{t('chapterReview.connect.close')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}

/**
 * End of a chapter row: "✓ Reviewed →" to the summary, or the small Review button.
 */
export function ChapterReviewAction({ book, chapter, reviewed }: {
  book: { title: string; author?: string | null } & ReviewBookRef
  chapter: { slug: string; title: string; wordCount?: number | null }
  reviewed: boolean
}) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const ref: ReviewBookRef = 'userBookId' in book ? { userBookId: book.userBookId } : { editionId: book.editionId, slug: book.slug }

  if (reviewed) {
    return (
      <TouchableOpacity
        onPress={() => router.push(chapterReviewRoute(ref, chapter.slug))}
        accessibilityRole="link"
        accessibilityLabel={t('chapterReview.openReviewAria').replace('{{title}}', chapter.title)}
        hitSlop={8}
      >
        <Text style={[styles.reviewed, { color: colors.success }]}>✓ {t('chapterReview.reviewed')} →</Text>
      </TouchableOpacity>
    )
  }
  // Front/back matter and thin chapters get no Review button (a reviewed one keeps its link above).
  if (!isReviewableChapter(chapter)) return null
  return (
    <ReviewChapterButton
      title={book.title}
      author={book.author}
      {...('userBookId' in book ? { bookId: book.userBookId } : { editionId: book.editionId })}
      chapterSlug={chapter.slug}
      chapterTitle={chapter.title}
    />
  )
}

const styles = StyleSheet.create({
  pill: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, marginLeft: 8 },
  pillText: { fontSize: 12, fontFamily: fonts.sansMedium },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowPrimary: { alignSelf: 'stretch' },
  switch: { marginLeft: 4, paddingVertical: 4, paddingHorizontal: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  primary: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, alignItems: 'center' },
  primaryText: { fontSize: 15, fontFamily: fonts.sansMedium },
  reviewed: { fontSize: 12, fontFamily: fonts.sansMedium, marginLeft: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { padding: 20, paddingBottom: 36, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10 },
  sheetTitle: { fontSize: 18, fontFamily: fonts.serifBold },
  body: { fontSize: 14, lineHeight: 20, fontFamily: fonts.sans },
  urlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  url: { fontSize: 13, fontFamily: fonts.sans, flexShrink: 1 },
  link: { fontSize: 14, fontFamily: fonts.sansMedium },
  sheetActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
})
