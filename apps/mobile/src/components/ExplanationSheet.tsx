import { useState, useEffect, useRef } from 'react'
import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { explainApi } from '@textstack/shared'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { fill } from '../lib/fill'
import { useTargetLanguage } from '../hooks/useTargetLanguage'
import { fonts } from '../theme/typography'

interface ExplanationSheetProps {
  visible: boolean
  word: string
  sentence: string
  bookId?: string
  fromLang?: string
  onClose: () => void
}

export function ExplanationSheet({ visible, word, sentence, bookId, fromLang: fromOverride, onClose }: ExplanationSheetProps) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const reduceMotion = useReduceMotion()
  // Explanations are addressed to the reader, so this is readerLang and never
  // null: explaining an English word in English is useful, unlike translating
  // one into itself.
  const { readerLang } = useTargetLanguage(fromOverride)
  const [explanation, setExplanation] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!visible || !word) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError('')
    setExplanation('')
    explainApi.explain({ word, sentence, bookId, targetLang: readerLang }, ctrl.signal)
      .then(res => { if (!ctrl.signal.aborted) setExplanation(res.explanation) })
      .catch(err => {
        if (ctrl.signal.aborted) return
        if (err instanceof Error && err.name === 'AbortError') return
        setError(t('reader.explanationSheet.failed'))
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => { ctrl.abort() }
  }, [visible, word, sentence, readerLang, bookId])

  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 12 }} />
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{fill(t('reader.explanationSheet.title'), { word })}</Text>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }} accessibilityRole="button" accessibilityLabel={t('reader.explanationSheet.close')}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 16 }}>
            {loading && <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} accessibilityLabel={t('reader.explanationSheet.generating')} />}
            {error ? <Text style={{ color: colors.error, marginTop: 8 }} accessibilityRole="alert">{error}</Text> : null}
            {explanation ? <Text style={[styles.text, { color: colors.text }]}>{explanation}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 32, maxHeight: '70%' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16, borderBottomWidth: 1,
  },
  title: { fontSize: 17, fontFamily: fonts.sansBold },
  body: { padding: 16 },
  text: { fontSize: 16, lineHeight: 24 },
})
