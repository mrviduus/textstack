import { useEffect, useRef, useState } from 'react'
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, TextInput,
  Switch, ScrollView, ActivityIndicator, Platform, Pressable,
} from 'react-native'
import type { ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { ApiError } from '@textstack/shared'
import { vocabularyApi } from '../../lib/vocabularyApi'
import type { VocabSettingsDto } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'

// RN Modal on Expo Web has long-standing pointer-events bugs: the modal
// host is rendered inline (not portaled), so z-index collisions with
// parent transforms/fixed headers are common, and the scrim can leak
// taps through to the underlying tree. On web we render a custom
// fixed-position overlay instead; on native we keep Modal.
const IS_WEB = Platform.OS === 'web'
const WEB_OVERLAY_STYLE = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
} as unknown as ViewStyle

interface Props {
  visible: boolean
  onClose: () => void
  onSaved?: () => void
}

const DAILY_CAP_MIN = 5
const DAILY_CAP_MAX = 100
const WEEKLY_BUDGET_MIN = 10
const WEEKLY_BUDGET_MAX = 500

type FieldKey = 'dailyCap' | 'weeklyBudget'

const parseIntStrict = (s: string): number | null => {
  if (!/^\d+$/.test(s)) return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

export function VocabSettingsModal({ visible, onClose, onSaved }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const [settings, setSettings] = useState<VocabSettingsDto | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalidField, setInvalidField] = useState<FieldKey | null>(null)
  const [dailyCapText, setDailyCapText] = useState('')
  const [weeklyBudgetText, setWeeklyBudgetText] = useState('')

  const scrollRef = useRef<ScrollView>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!visible) return
    let mounted = true
    setError(null)
    setInvalidField(null)
    setSettings(null)
    vocabularyApi.getVocabSettings()
      .then(s => {
        if (!mounted) return
        setSettings(s)
        setDailyCapText(String(s.dailyNewCap))
        setWeeklyBudgetText(String(s.weeklyReviewBudget))
      })
      .catch(() => { if (mounted) setError(t('vocabulary.settings.loadFailed')) })
    return () => { mounted = false }
  }, [visible, t])

  const patch = (p: Partial<VocabSettingsDto>) => {
    setSettings(prev => prev ? { ...prev, ...p } : prev)
  }

  const flagInvalid = (field: FieldKey, msg: string) => {
    setError(msg)
    setInvalidField(field)
    scrollRef.current?.scrollTo({ y: 0, animated: true })
  }

  const handleSave = async () => {
    if (!settings) return
    const dailyCap = parseIntStrict(dailyCapText)
    if (dailyCap === null || dailyCap < DAILY_CAP_MIN || dailyCap > DAILY_CAP_MAX) {
      flagInvalid('dailyCap', t('vocabulary.settings.dailyCapRange'))
      return
    }
    const weeklyBudget = parseIntStrict(weeklyBudgetText)
    if (weeklyBudget === null || weeklyBudget < WEEKLY_BUDGET_MIN || weeklyBudget > WEEKLY_BUDGET_MAX) {
      flagInvalid('weeklyBudget', t('vocabulary.settings.weeklyBudgetRange'))
      return
    }
    setInvalidField(null)
    setSaving(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const payload: VocabSettingsDto = {
        ...settings,
        dailyNewCap: dailyCap,
        weeklyReviewBudget: weeklyBudget,
      }
      const saved = await vocabularyApi.updateVocabSettings(payload, controller.signal)
      if (controller.signal.aborted) return
      setSettings(saved)
      onSaved?.()
      onClose()
    } catch (e) {
      if (controller.signal.aborted) return
      // safeFetch wraps AbortError into ApiError(0, ...) with isNetworkError=true.
      // If we aborted after the throw path, swallow silently.
      if (e instanceof ApiError && e.isNetworkError && controller.signal.aborted) return
      setError(t('vocabulary.settings.saveFailed'))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setSaving(false)
    }
  }

  const handleClose = () => {
    // Cancel in-flight save — user explicitly opted out. safeFetch turns
    // the abort into an ApiError the catch block drops on the floor.
    abortRef.current?.abort()
    abortRef.current = null
    setSaving(false)
    onClose()
  }

  const onChangeDigits = (setter: (v: string) => void, field: FieldKey) => (v: string) => {
    setter(v.replace(/[^\d]/g, ''))
    if (invalidField === field) {
      setInvalidField(null)
      setError(null)
    }
  }

  const fieldBorder = (field: FieldKey) =>
    invalidField === field ? '#ef4444' : colors.border

  const sheet = (
    // Backdrop Pressable catches taps outside the sheet. The inner
    // Pressable stops propagation so taps inside don't close — matches
    // LanguagePickerModal's pattern and works on both native + web
    // (RN-Web translates Pressable onPress to a click handler).
    <Pressable style={styles.overlay} onPress={handleClose}>
      <Pressable
        style={[styles.sheet, { backgroundColor: colors.background }]}
        onPress={(e) => e.stopPropagation?.()}
      >
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text, fontFamily: fonts.sansMedium }]}>
              {t('vocabulary.settings.title')}
            </Text>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView ref={scrollRef} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
              {t('vocabulary.settings.subtitle')}
            </Text>

            {settings === null && !error ? (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <>
                {error && (
                  <View style={[styles.errorBox, { borderColor: '#ef4444' }]}>
                    <Text style={[styles.errorText, { fontFamily: fonts.sans }]}>{error}</Text>
                  </View>
                )}

                <View style={styles.field}>
                  <Text style={[styles.label, { color: colors.text, fontFamily: fonts.sansMedium }]}>
                    {t('vocabulary.settings.dailyNewCap')}
                  </Text>
                  <Text style={[styles.hint, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                    {t('vocabulary.settings.dailyNewCapHint')}
                  </Text>
                  <TextInput
                    style={[styles.input, { backgroundColor: colors.surface, borderColor: fieldBorder('dailyCap'), color: colors.text, fontFamily: fonts.sans }]}
                    value={dailyCapText}
                    onChangeText={onChangeDigits(setDailyCapText, 'dailyCap')}
                    keyboardType="number-pad"
                    maxLength={3}
                    editable={!saving && !!settings}
                  />
                </View>

                <View style={styles.field}>
                  <Text style={[styles.label, { color: colors.text, fontFamily: fonts.sansMedium }]}>
                    {t('vocabulary.settings.weeklyBudget')}
                  </Text>
                  <Text style={[styles.hint, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                    {t('vocabulary.settings.weeklyBudgetHint')}
                  </Text>
                  <TextInput
                    style={[styles.input, { backgroundColor: colors.surface, borderColor: fieldBorder('weeklyBudget'), color: colors.text, fontFamily: fonts.sans }]}
                    value={weeklyBudgetText}
                    onChangeText={onChangeDigits(setWeeklyBudgetText, 'weeklyBudget')}
                    keyboardType="number-pad"
                    maxLength={3}
                    editable={!saving && !!settings}
                  />
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.label, { color: colors.text, fontFamily: fonts.sansMedium }]}>
                      {t('vocabulary.settings.frequencyFilter')}
                    </Text>
                    <Text style={[styles.hint, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                      {t('vocabulary.settings.frequencyFilterHint')}
                    </Text>
                  </View>
                  <Switch
                    value={!!settings?.frequencyFilterEnabled}
                    onValueChange={v => patch({ frequencyFilterEnabled: v })}
                    disabled={saving || !settings}
                  />
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.label, { color: colors.text, fontFamily: fonts.sansMedium }]}>
                      {t('vocabulary.settings.autoRetire')}
                    </Text>
                    <Text style={[styles.hint, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                      {t('vocabulary.settings.autoRetireHint')}
                    </Text>
                  </View>
                  <Switch
                    value={!!settings?.autoRetireEnabled}
                    onValueChange={v => patch({ autoRetireEnabled: v })}
                    disabled={saving || !settings}
                  />
                </View>

                {/* Moved here from the reader's settings drawer. It governs the review cards, and
                    this is the sheet a reader opens when looking for something about them. */}
                <View style={styles.toggleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.label, { color: colors.text, fontFamily: fonts.sansMedium }]}>
                      {t('vocabulary.settings.autoSpeak')}
                    </Text>
                    <Text style={[styles.hint, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                      {t('vocabulary.settings.autoSpeakHint')}
                    </Text>
                  </View>
                  <Switch
                    value={settings?.autoSpeakCards ?? true}
                    onValueChange={v => patch({ autoSpeakCards: v })}
                    disabled={saving || !settings}
                  />
                </View>
              </>
            )}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            <TouchableOpacity
              onPress={handleClose}
              style={[styles.btn, styles.cancelBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.cancelText, { color: colors.textSecondary, fontFamily: fonts.sansMedium }]}>
                {t('common.cancel')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              disabled={saving || !settings}
              style={[styles.btn, styles.saveBtn, { backgroundColor: colors.primary, opacity: (saving || !settings) ? 0.6 : 1 }]}
            >
              <Text style={[styles.saveText, { fontFamily: fonts.sansMedium }]}>
                {saving ? t('common.saving') : t('common.save')}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
  )

  if (IS_WEB) {
    if (!visible) return null
    return <View style={WEB_OVERLAY_STYLE}>{sheet}</View>
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      {sheet}
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '90%', borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
  },
  title: { fontSize: 17 },
  closeBtn: { padding: 4 },
  body: { padding: 16, gap: 16 },
  subtitle: { fontSize: 13, lineHeight: 18 },
  loading: { paddingVertical: 32, alignItems: 'center' },
  errorBox: { padding: 10, borderRadius: 8, borderWidth: 1, backgroundColor: '#fef2f2' },
  errorText: { color: '#b91c1c', fontSize: 13 },
  field: { gap: 6 },
  label: { fontSize: 14 },
  hint: { fontSize: 12, lineHeight: 16 },
  input: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  footer: {
    flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: 1,
  },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  cancelBtn: { borderWidth: 1 },
  cancelText: { fontSize: 14 },
  saveBtn: {},
  saveText: { color: '#fff', fontSize: 14 },
})
