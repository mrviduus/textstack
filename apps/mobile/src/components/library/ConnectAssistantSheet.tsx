import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable } from 'react-native'
import { router } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { MCP_ENDPOINT } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useToast } from '../../context/ToastContext'
import { fonts } from '../../theme/typography'

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

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { padding: 20, paddingBottom: 36, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10 },
  sheetTitle: { fontSize: 18, fontFamily: fonts.serifBold },
  body: { fontSize: 14, lineHeight: 20, fontFamily: fonts.sans },
  urlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  url: { fontSize: 13, fontFamily: fonts.sans, flexShrink: 1 },
  link: { fontSize: 14, fontFamily: fonts.sansMedium },
  sheetActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
})
