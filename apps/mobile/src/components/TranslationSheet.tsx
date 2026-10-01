import { useState, useEffect } from 'react'
import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { useNativeLanguage } from '../context/NativeLanguageContext'
import { useTargetLanguage } from '../hooks/useTargetLanguage'
import { useNeedsNativeLanguage } from '../hooks/useNeedsNativeLanguage'
import { LanguageList } from './LanguageList'
import { getLanguage } from '@textstack/shared'
import { fonts } from '../theme/typography'
import { cachedTranslate } from '../lib/translateCache'

interface TranslationSheetProps {
  visible: boolean
  text: string
  onClose: () => void
  onSpeak: (text: string) => void
  /**
   * Override the source language (book language). Falls back to the UI
   * reading language from `useLanguage()` when omitted.
   */
  fromLang?: string
}

export function TranslationSheet({ visible, text, onClose, onSpeak, fromLang: fromOverride }: TranslationSheetProps) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { fromLang, translationTarget } = useTargetLanguage(fromOverride)
  /**
   * Where the language question is asked, and why here.
   *
   * The full-screen route (`app/onboarding/language.tsx`) is `gestureEnabled:
   * false` — firing it mid-chapter throws the reader out of the book, which is
   * the one thing this product refuses to do. So the question moves to the
   * first moment it is *needed rather than merely due*: this sheet cannot do
   * its job without a target language. The answer is not a form submission,
   * it is the translation appearing.
   *
   * Web reached the same place from the other direction — its picker sits
   * inline in the hero subtitle and pulses (`HeroSection.tsx`), never as a
   * gate. Same rule: ask where the answer is immediately spent.
   */
  const needsLanguage = useNeedsNativeLanguage()
  const { nativeLanguage, setNativeLanguage } = useNativeLanguage()
  // Human-readable native labels for the sheet header. Fall back to the
  // uppercased language code (e.g. "EN") when the code isn't in our
  // catalogue — no throw, no blank space.
  const label = (code: string) => getLanguage(code)?.nativeName ?? code.toUpperCase()
  const fromLabel = label(fromLang)
  const toLabel = translationTarget ? label(translationTarget) : null
  const [translated, setTranslated] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Two reasons not to fire a request. No target: the reader knows this
    // language, so don't spend one proving that English means English — the
    // sheet says so instead. `needsLanguage`: the target we hold is a guess
    // nobody confirmed, and the question is on screen instead. Translating on a
    // guess would also file a `translation_used` event for a translation the
    // reader never asked for in that language.
    if (!visible || !text || !translationTarget || needsLanguage) return
    setLoading(true)
    setError('')
    setTranslated('')
    // `cachedTranslate`, not `translationApi.translate`. This sheet is opened
    // from the selection toolbar, which has ALREADY fetched and memoized the
    // gloss for exactly this text — going direct re-bought a paid
    // `gpt-4.1-nano` call for a string the process was holding in memory, and
    // never wrote its own answer back for the next reader of the same word.
    cachedTranslate(text, fromLang, translationTarget)
      .then(({ translation }) => {
        setTranslated(translation)
      })
      .catch(() => setError('Translation failed'))
      .finally(() => setLoading(false))
    // `needsLanguage` is a dependency, not just a guard: answering with the
    // language we had already guessed leaves `translationTarget` unchanged, and
    // without it in the list the sheet would sit empty after a correct answer.
  }, [visible, text, fromLang, translationTarget, needsLanguage])

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 12 }} />
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Translation</Text>
            <TouchableOpacity
              onPress={onClose}
              style={{ padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Close translation"
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.body}>
            <View style={styles.textBlock}>
              <View style={styles.langRow}>
                <Text style={[styles.langLabel, { color: colors.primary }]}>{fromLabel}</Text>
                <TouchableOpacity
                  onPress={() => onSpeak(text)}
                  accessibilityRole="button"
                  accessibilityLabel={`Pronounce in ${fromLabel}`}
                >
                  <Ionicons name="volume-high-outline" size={20} color={colors.primary} />
                </TouchableOpacity>
              </View>
              <Text
                style={[styles.originalText, { color: colors.text }]}
                numberOfLines={needsLanguage ? 3 : undefined}
              >
                {text}
              </Text>
            </View>

            <View style={[styles.divider, { backgroundColor: colors.border }]} />

            <View style={styles.textBlock}>
              {needsLanguage ? (
                <>
                  <Text style={[styles.askTitle, { color: colors.text }]} accessibilityRole="header">
                    {t('onboarding.nativeLanguageTitle')}
                  </Text>
                  <Text style={[styles.askSubtitle, { color: colors.textSecondary }]}>
                    {t('onboarding.nativeLanguageSubtitle')}
                  </Text>
                  {/* The same searchable list the full-screen route uses — one
                      list, so the two places the question is asked cannot drift.
                      Selecting IS confirming: `setNativeLanguage` stamps the
                      owner and pushes to the profile, and the effect above then
                      runs and fills this block with the translation. No confirm
                      button, because a second tap would buy nothing. */}
                  <View style={styles.askList}>
                    <LanguageList value={nativeLanguage} onSelect={setNativeLanguage} />
                  </View>
                </>
              ) : toLabel ? (
                <>
                  <Text style={[styles.langLabel, { color: colors.primary }]}>{`\u2192 ${toLabel}`}</Text>
                  {loading && <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} accessibilityLabel="Translating" />}
                  {error ? <Text style={{ color: colors.error, marginTop: 8 }} accessibilityRole="alert">{error}</Text> : null}
                  {translated ? <Text style={[styles.translatedText, { color: colors.text }]}>{translated}</Text> : null}
                </>
              ) : (
                <Text style={[styles.translatedText, { color: colors.textSecondary }]}>
                  {`You read ${fromLabel} natively, so there is nothing to translate into. Pick a different language in Profile.`}
                </Text>
              )}
            </View>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  title: { fontSize: 17, fontFamily: fonts.sansBold },
  body: { padding: 16 },
  textBlock: { marginBottom: 8 },
  langRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  langLabel: {
    fontSize: 12,
    fontFamily: fonts.sansBold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  originalText: { fontSize: 16, lineHeight: 24 },
  askTitle: { fontSize: 17, fontFamily: fonts.sansBold, marginBottom: 4 },
  askSubtitle: { fontSize: 13, fontFamily: fonts.sans, lineHeight: 18, marginBottom: 10 },
  // Bounded: LanguageList is a FlatList with `flex: 1`, and this sheet sizes to
  // its content, so an unbounded parent renders a list of height zero.
  askList: { height: 260 },
  divider: {
    height: 1,
    marginVertical: 12,
  },
  translatedText: { fontSize: 16, lineHeight: 24 },
})
