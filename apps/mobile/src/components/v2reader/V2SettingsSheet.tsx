import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import {
  ALIGNS, FAMILIES, FONT_MAX, FONT_MIN, FONT_STEP, LINE_HEIGHTS, SETTINGS_KEY, THEMES, choose, parseChosen, readSettings,
  type V2FontFamily, type V2Settings, type V2TextAlign, type V2Theme,
} from '../../lib/v2reader/settings.mjs'

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

const FAMILY_LABEL: Record<V2FontFamily, string> = { serif: 'Serif', sans: 'Sans', dyslexic: 'Dyslexic' }
// `book`: the book's own alignment, the default (no rule of ours).
const ALIGN_LABEL: Record<V2TextAlign, string> = { book: 'Book', left: 'Left', center: 'Center', justify: 'Justify' }
const THEME_LABEL: Record<V2Theme, string> = { light: 'Light', sepia: 'Sepia', dark: 'Dark' }

interface Props {
  visible: boolean
  onClose: () => void
  settings: V2Settings
  onUpdate: (patch: Partial<V2Settings>) => void
  /** False for a fixed-layout book (PDF, CBZ, a pre-paginated EPUB): only the theme applies, the rest is disabled. */
  typography: boolean
}

/** The settings sheet: the legacy reader's drawer (ReaderSettingsDrawer.tsx) with the five V2 settings. */
export function V2SettingsSheet({ visible, onClose, settings, onUpdate, typography }: Props) {
  const { colors } = useTheme()
  const chip = (selected: boolean) => [styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }, selected && { backgroundColor: colors.primary, borderColor: colors.primary }]
  const chipText = (selected: boolean) => [styles.chipText, { color: colors.text }, selected && { color: '#fff' }]
  const label = (text: string) => <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{text}</Text>
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* The backdrop in its own layer: a Pressable ancestor would take the list's scroll gesture. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close reading settings" />
        <View style={[styles.drawer, { backgroundColor: colors.background }]}>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Reading Settings</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close reading settings">
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {label('THEME')}
            <View style={styles.row}>
              {(Object.keys(THEMES) as V2Theme[]).map((theme) => (
                <TouchableOpacity
                  key={theme}
                  style={[styles.themeChip, { backgroundColor: THEMES[theme].bg, borderColor: settings.theme === theme ? colors.primary : colors.border }]}
                  onPress={() => onUpdate({ theme })}
                  accessibilityRole="button"
                  accessibilityLabel={`${THEME_LABEL[theme]} theme`}
                  accessibilityState={{ selected: settings.theme === theme }}
                >
                  <Text style={[styles.themeLabel, { color: THEMES[theme].fg }]}>{THEME_LABEL[theme]}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {!typography && <Text style={[styles.note, { color: colors.textSecondary }]}>This book has a fixed layout: only the theme applies.</Text>}
            {/* One wrapper turns every typography control off: no touches, hidden from TalkBack, dimmed. */}
            <View
              pointerEvents={typography ? 'auto' : 'none'}
              importantForAccessibility={typography ? 'auto' : 'no-hide-descendants'}
              accessibilityElementsHidden={!typography}
              style={!typography && styles.disabled}
            >
              {label('FONT SIZE')}
              <View style={styles.row}>
                <TouchableOpacity
                  style={[styles.sizeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  onPress={() => onUpdate({ fontSize: settings.fontSize - FONT_STEP })}
                  disabled={settings.fontSize <= FONT_MIN}
                  accessibilityRole="button"
                  accessibilityLabel="Decrease font size"
                >
                  <Text style={[styles.sizeText, { color: colors.text }]}>A-</Text>
                </TouchableOpacity>
                <View style={styles.sizePreview}><Text style={[styles.sizeValue, { color: colors.text }]}>{settings.fontSize}px</Text></View>
                <TouchableOpacity
                  style={[styles.sizeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  onPress={() => onUpdate({ fontSize: settings.fontSize + FONT_STEP })}
                  disabled={settings.fontSize >= FONT_MAX}
                  accessibilityRole="button"
                  accessibilityLabel="Increase font size"
                >
                  <Text style={[styles.sizeText, { color: colors.text }]}>A+</Text>
                </TouchableOpacity>
              </View>

              {label('FONT')}
              <View style={styles.row}>
                {FAMILIES.map((fontFamily) => (
                  <TouchableOpacity key={fontFamily} style={chip(settings.fontFamily === fontFamily)} onPress={() => onUpdate({ fontFamily })}
                    accessibilityRole="button" accessibilityLabel={`${FAMILY_LABEL[fontFamily]} font`} accessibilityState={{ selected: settings.fontFamily === fontFamily }}>
                    <Text style={chipText(settings.fontFamily === fontFamily)}>{FAMILY_LABEL[fontFamily]}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {label('LINE HEIGHT')}
              <View style={styles.row}>
                {LINE_HEIGHTS.map((lineHeight) => (
                  <TouchableOpacity key={lineHeight} style={chip(settings.lineHeight === lineHeight)} onPress={() => onUpdate({ lineHeight })}
                    accessibilityRole="button" accessibilityLabel={`Line height ${lineHeight}`} accessibilityState={{ selected: settings.lineHeight === lineHeight }}>
                    <Text style={chipText(settings.lineHeight === lineHeight)}>{lineHeight}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {label('TEXT ALIGN')}
              <View style={styles.row}>
                {ALIGNS.map((textAlign) => (
                  <TouchableOpacity key={textAlign} style={chip(settings.textAlign === textAlign)} onPress={() => onUpdate({ textAlign })}
                    accessibilityRole="button" accessibilityLabel={`Text align ${ALIGN_LABEL[textAlign]}`} accessibilityState={{ selected: settings.textAlign === textAlign }}>
                    <Text style={chipText(settings.textAlign === textAlign)}>{ALIGN_LABEL[textAlign]}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
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
  sectionLabel: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
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
})
