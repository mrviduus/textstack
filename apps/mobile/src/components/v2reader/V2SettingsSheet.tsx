import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useReduceMotion } from '../../hooks/useReduceMotion'
import { fill } from '../../lib/fill'
import { fonts } from '../../theme/typography'
import {
  ALIGNS, FAMILIES, FONT_MAX, FONT_MIN, FONT_STEP, LINE_HEIGHTS, SETTINGS_KEY, THEMES, choose, parseChosen, readSettings,
  type V2FontFamily, type V2Settings, type V2TextAlign, type V2Theme,
} from '../../../../../packages/reader/src/settings.mjs'
import { TTS_SPEEDS, TTS_SPEED_KEY, createSpeedChoice } from '../../../../../packages/reader/src/listen.mjs'

/**
 * The reader's choices (#1260), read once for the process and replaced by every change (as the flow choice):
 * each page load applies them before its first open. settings.mjs reads the stored value: a damaged or older
 * one is no choice.
 */
let stored: Promise<Partial<V2Settings>> | null = null
export const storedV2Settings = () => (stored ??= AsyncStorage.getItem(SETTINGS_KEY).then(parseChosen, () => ({})))

/** The V2 reader's settings on this device: the defaults until the stored choices are read. */
export function useV2Settings() {
  const [chosen, setChosen] = useState<Partial<V2Settings> | null>(null)
  useEffect(() => { storedV2Settings().then(setChosen) }, [])
  const settings = useMemo(() => readSettings(chosen), [chosen])
  const update = (patch: Partial<V2Settings>) => {
    // Not before the stored choices are in: a change then would write over them.
    if (!chosen) return
    const next = choose(chosen, patch)
    stored = Promise.resolve(next)
    setChosen(next)
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)).catch((e) => console.log(`[v2] settings not saved: ${e}`))
  }
  return { settings, update }
}

/** #1272: Listen's speed on this device (the host's alone, never the page's); 1 until the stored one is read. */
export function useV2TtsSpeed() {
  const [speed, setSpeed] = useState(1)
  // createSpeedChoice: a speed picked before the stored one is read wins.
  const [update] = useState(() => createSpeedChoice({
    load: () => AsyncStorage.getItem(TTS_SPEED_KEY),
    save: (v) => { AsyncStorage.setItem(TTS_SPEED_KEY, v).catch((e) => console.log(`[v2] speech speed not saved: ${e}`)) },
    show: setSpeed,
  }))
  return { speed, update }
}

const FAMILY_LABEL: Record<V2FontFamily, string> = { serif: 'reader.v2Settings.serif', sans: 'reader.v2Settings.sans', dyslexic: 'reader.v2Settings.dyslexic' }
// `book`: the book's own alignment, the default (no rule of ours).
const ALIGN_LABEL: Record<V2TextAlign, string> = { book: 'reader.v2Settings.alignBook', left: 'reader.v2Settings.alignLeft', center: 'reader.v2Settings.alignCenter', justify: 'reader.v2Settings.alignJustify' }
const THEME_LABEL: Record<V2Theme, string> = { light: 'reader.v2Settings.light', sepia: 'reader.v2Settings.sepia', dark: 'reader.v2Settings.dark' }

interface Props {
  visible: boolean
  onClose: () => void
  settings: V2Settings
  onUpdate: (patch: Partial<V2Settings>) => void
  /** False for a fixed-layout book (PDF, CBZ, a pre-paginated EPUB): only the theme applies, the rest is disabled. */
  typography: boolean
  /** #1272: Listen's speed and its change. */
  ttsSpeed: number
  onTtsSpeed: (v: number) => void
  /** #1271: saved words' translations shown (the legacy reader's `showInlineTranslations`); absent where nothing is marked. */
  glosses?: { on: boolean; onChange: (on: boolean) => void }
}

/** The settings sheet: the legacy reader's drawer (ReaderSettingsDrawer.tsx) with the five V2 settings. */
export function V2SettingsSheet({ visible, onClose, settings, onUpdate, typography, ttsSpeed, onTtsSpeed, glosses }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const reduceMotion = useReduceMotion()
  const chip = (selected: boolean) => [styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }, selected && { backgroundColor: colors.primary, borderColor: colors.primary }]
  const chipText = (selected: boolean) => [styles.chipText, { color: colors.text }, selected && { color: '#fff' }]
  const label = (text: string) => <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{text}</Text>
  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* The backdrop in its own layer: a Pressable ancestor would take the list's scroll gesture. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('reader.chrome.closeSettings')} />
        <View style={[styles.drawer, { backgroundColor: colors.background }]} accessibilityViewIsModal>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{t('reader.chrome.settings')}</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={t('reader.chrome.closeSettings')}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {label(t('reader.v2Settings.theme'))}
            <View style={styles.row}>
              {(Object.keys(THEMES) as V2Theme[]).map((theme) => (
                <TouchableOpacity
                  key={theme}
                  style={[styles.themeChip, { backgroundColor: THEMES[theme].bg, borderColor: settings.theme === theme ? colors.primary : colors.border }]}
                  onPress={() => onUpdate({ theme })}
                  accessibilityRole="button"
                  accessibilityLabel={fill(t('reader.v2Settings.themeLabel'), { name: t(THEME_LABEL[theme]) })}
                  accessibilityState={{ selected: settings.theme === theme }}
                >
                  <Text style={[styles.themeLabel, { color: THEMES[theme].fg }]}>{t(THEME_LABEL[theme])}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {!typography && <Text style={[styles.note, { color: colors.textSecondary }]}>{t('reader.v2Settings.fixedLayout')}</Text>}
            {/* One wrapper turns every typography control off: no touches, hidden from TalkBack, dimmed. */}
            <View
              pointerEvents={typography ? 'auto' : 'none'}
              importantForAccessibility={typography ? 'auto' : 'no-hide-descendants'}
              accessibilityElementsHidden={!typography}
              style={!typography && styles.disabled}
            >
              {label(t('reader.v2Settings.fontSize'))}
              <View style={styles.row}>
                <TouchableOpacity
                  style={[styles.sizeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  onPress={() => onUpdate({ fontSize: settings.fontSize - FONT_STEP })}
                  disabled={settings.fontSize <= FONT_MIN}
                  accessibilityRole="button"
                  accessibilityLabel={t('reader.v2Settings.fontSmaller')}
                >
                  <Text style={[styles.sizeText, { color: colors.text }]}>A-</Text>
                </TouchableOpacity>
                <View style={styles.sizePreview}><Text style={[styles.sizeValue, { color: colors.text }]}>{settings.fontSize}px</Text></View>
                <TouchableOpacity
                  style={[styles.sizeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  onPress={() => onUpdate({ fontSize: settings.fontSize + FONT_STEP })}
                  disabled={settings.fontSize >= FONT_MAX}
                  accessibilityRole="button"
                  accessibilityLabel={t('reader.v2Settings.fontLarger')}
                >
                  <Text style={[styles.sizeText, { color: colors.text }]}>A+</Text>
                </TouchableOpacity>
              </View>

              {label(t('reader.v2Settings.font'))}
              <View style={styles.row}>
                {FAMILIES.map((fontFamily) => (
                  <TouchableOpacity key={fontFamily} style={chip(settings.fontFamily === fontFamily)} onPress={() => onUpdate({ fontFamily })}
                    accessibilityRole="button" accessibilityLabel={fill(t('reader.v2Settings.fontLabel'), { name: t(FAMILY_LABEL[fontFamily]) })} accessibilityState={{ selected: settings.fontFamily === fontFamily }}>
                    <Text style={chipText(settings.fontFamily === fontFamily)}>{t(FAMILY_LABEL[fontFamily])}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {label(t('reader.v2Settings.lineHeight'))}
              <View style={styles.row}>
                {LINE_HEIGHTS.map((lineHeight) => (
                  <TouchableOpacity key={lineHeight} style={chip(settings.lineHeight === lineHeight)} onPress={() => onUpdate({ lineHeight })}
                    accessibilityRole="button" accessibilityLabel={fill(t('reader.v2Settings.lineHeightLabel'), { value: lineHeight })} accessibilityState={{ selected: settings.lineHeight === lineHeight }}>
                    <Text style={chipText(settings.lineHeight === lineHeight)}>{lineHeight}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {label(t('reader.v2Settings.textAlign'))}
              <View style={styles.row}>
                {ALIGNS.map((textAlign) => (
                  <TouchableOpacity key={textAlign} style={chip(settings.textAlign === textAlign)} onPress={() => onUpdate({ textAlign })}
                    accessibilityRole="button" accessibilityLabel={fill(t('reader.v2Settings.textAlignLabel'), { name: t(ALIGN_LABEL[textAlign]) })} accessibilityState={{ selected: settings.textAlign === textAlign }}>
                    <Text style={chipText(settings.textAlign === textAlign)}>{t(ALIGN_LABEL[textAlign])}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {label(t('reader.v2Settings.speechSpeed'))}
            <View style={styles.row}>
              {TTS_SPEEDS.map((v) => (
                <TouchableOpacity key={v} style={chip(ttsSpeed === v)} onPress={() => onTtsSpeed(v)}
                  accessibilityRole="button" accessibilityLabel={fill(t('reader.v2Settings.speechSpeedLabel'), { value: v })} accessibilityState={{ selected: ttsSpeed === v }}>
                  <Text style={chipText(ttsSpeed === v)}>{v}x</Text>
                </TouchableOpacity>
              ))}
            </View>

            {glosses && (
              // The legacy drawer's switch (ReaderSettingsDrawer.tsx), the same stored setting.
              <>
                {label(t('reader.inlineTranslations').toUpperCase())}
                <View style={styles.toggleRow}>
                  <Text style={[styles.toggleLabel, { color: colors.text }]}>{t('reader.inlineTranslationsDesc')}</Text>
                  <Switch
                    value={glosses.on}
                    onValueChange={glosses.onChange}
                    trackColor={{ true: colors.primary, false: colors.border }}
                    thumbColor="#fff"
                    accessibilityLabel={t('reader.inlineTranslationsDesc')}
                  />
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  drawer: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40, maxHeight: '80%' },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  title: { fontFamily: fonts.serifBold, fontSize: 20 },
  closeBtn: { padding: 8, minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  sectionLabel: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 0.5, marginTop: 18, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  note: { fontFamily: fonts.sans, fontSize: 13, marginTop: 14 },
  disabled: { opacity: 0.4 },
  sizeButton: { width: 44, height: 44, borderRadius: 10, justifyContent: 'center', alignItems: 'center', borderWidth: 1 },
  sizeText: { fontFamily: fonts.sansBold, fontSize: 16 },
  sizePreview: { flex: 1, alignItems: 'center' },
  sizeValue: { fontFamily: fonts.sansMedium, fontSize: 16 },
  chip: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1 },
  chipText: { fontFamily: fonts.sansMedium, fontSize: 14 },
  themeChip: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center', borderWidth: 2 },
  themeLabel: { fontFamily: fonts.sansMedium, fontSize: 12 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  toggleLabel: { fontFamily: fonts.sans, fontSize: 14, flex: 1, marginRight: 12 },
})
