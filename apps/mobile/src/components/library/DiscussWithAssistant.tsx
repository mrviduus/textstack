import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native'
import { buildHandoffBrief, handoffUrl, type HandoffBook, type Assistant } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'

/**
 * "Talk this book over" — the handoff out of TextStack and into a real chat.
 *
 * We are not building the chat. The reader's assistant already has their profile,
 * their memory and a year of conversation, and none of that can be copied here.
 * So this is a LINK: it opens a new conversation in Claude or ChatGPT with an
 * opening message already written. See `lib/assistantHandoff.ts` in the shared
 * package for what the brief carries and why it is capped.
 *
 * `Linking.openURL` hands the URL to the OS, so on a phone with the Claude or
 * ChatGPT app installed the deep link opens the app; without it, the browser.
 * Either way the conversation starts with the book already named.
 *
 * Failures are swallowed on purpose. `openURL` rejects when nothing can handle
 * the scheme, and there is nothing useful to say about that beyond what not
 * opening already says — an alert here would be an error dialog for "you have no
 * browser", which is not a state worth a modal.
 */
export function DiscussWithAssistant(props: HandoffBook) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const brief = buildHandoffBrief(props)

  const open = (assistant: Assistant) => {
    Linking.openURL(handoffUrl(assistant, brief)).catch(() => {})
  }

  return (
    <View style={[styles.section, { borderTopColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.text }]}>{t('library.discuss.label')}</Text>
      <View style={styles.row}>
        {([['claude', t('library.discuss.claude')], ['chatgpt', t('library.discuss.chatgpt')]] as const).map(([id, label]) => (
          <TouchableOpacity
            key={id}
            style={[styles.btn, { borderColor: colors.border, backgroundColor: colors.surface }]}
            onPress={() => open(id)}
            accessibilityRole="button"
            accessibilityLabel={label}
          >
            <Text style={[styles.btnText, { color: colors.text }]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('library.discuss.hint')}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 15, fontFamily: fonts.sansBold, marginBottom: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  btnText: { fontSize: 14, fontFamily: fonts.sansMedium },
  hint: { marginTop: 10, fontSize: 12, lineHeight: 17, fontFamily: fonts.sans },
})
