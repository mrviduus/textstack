import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Switch, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../context/ThemeContext'
import { fonts } from '../theme/typography'
import type { ReaderSettings } from '../hooks/useReaderSettings'
import { themeStyles } from '../hooks/useReaderSettings'

interface Props {
  visible: boolean
  onClose: () => void
  settings: ReaderSettings
  onUpdate: (patch: Partial<ReaderSettings>) => void
}

const lineHeights = [1.5, 1.6, 1.65, 1.8]
const fontOptions: { key: ReaderSettings['fontFamily']; label: string }[] = [
  { key: 'serif', label: 'Serif' },
  { key: 'sans', label: 'Sans' },
  { key: 'dyslexic', label: 'Dyslexic' },
]
const textAligns: { key: ReaderSettings['textAlign']; label: string }[] = [
  { key: 'left', label: 'Left' },
  { key: 'center', label: 'Center' },
  { key: 'justify', label: 'Justify' },
]
const themeOptions: { key: ReaderSettings['theme']; label: string }[] = [
  { key: 'light', label: 'Light' },
  { key: 'sepia', label: 'Sepia' },
  { key: 'dark', label: 'Dark' },
]
const ttsSpeeds = [0.75, 1.0, 1.25, 1.5, 2.0]

export function ReaderSettingsDrawer({ visible, onClose, settings, onUpdate }: Props) {
  const { colors } = useTheme()

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* Backdrop tap-to-close in its own absolute layer — must NOT wrap the
            drawer/ScrollView. A Pressable ancestor steals the scroll gesture on
            iOS, which made the settings list unscrollable (couldn't reach
            Inline Translations / Reading Stats). */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close reader settings"
        />
        <View style={[styles.drawer, { backgroundColor: colors.background }]}>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Reading Settings</Text>
              <TouchableOpacity
                onPress={onClose}
                style={styles.closeBtn}
                accessibilityRole="button"
                accessibilityLabel="Close reader settings"
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Font Size */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>FONT SIZE</Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.sizeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => onUpdate({ fontSize: Math.max(14, settings.fontSize - 2) })}
                accessibilityRole="button"
                accessibilityLabel="Decrease font size"
              >
                <Text style={[styles.sizeText, { color: colors.text }]}>A-</Text>
              </TouchableOpacity>
              <View style={styles.sizePreview}>
                <Text style={[styles.sizeValue, { color: colors.text }]}>{settings.fontSize}px</Text>
              </View>
              <TouchableOpacity
                style={[styles.sizeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => onUpdate({ fontSize: Math.min(28, settings.fontSize + 2) })}
                accessibilityRole="button"
                accessibilityLabel="Increase font size"
              >
                <Text style={[styles.sizeText, { color: colors.text }]}>A+</Text>
              </TouchableOpacity>
            </View>

            {/* Line Height */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>LINE HEIGHT</Text>
            <View style={styles.row}>
              {lineHeights.map(lh => (
                <TouchableOpacity
                  key={lh}
                  style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border },
                    settings.lineHeight === lh && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => onUpdate({ lineHeight: lh })}
                  accessibilityRole="button"
                  accessibilityLabel={`Line height ${lh}`}
                  accessibilityState={{ selected: settings.lineHeight === lh }}
                >
                  <Text style={[styles.chipText, { color: colors.text },
                    settings.lineHeight === lh && { color: '#fff' }]}>{lh}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Text Align */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>TEXT ALIGN</Text>
            <View style={styles.row}>
              {textAligns.map(a => (
                <TouchableOpacity
                  key={a.key}
                  style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border },
                    settings.textAlign === a.key && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => onUpdate({ textAlign: a.key })}
                  accessibilityRole="button"
                  accessibilityLabel={`Text align ${a.label}`}
                  accessibilityState={{ selected: settings.textAlign === a.key }}
                >
                  <Text style={[styles.chipText, { color: colors.text },
                    settings.textAlign === a.key && { color: '#fff' }]}>{a.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Theme */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>THEME</Text>
            <View style={styles.row}>
              {themeOptions.map(t => (
                <TouchableOpacity
                  key={t.key}
                  style={[styles.themeChip, { backgroundColor: themeStyles[t.key].backgroundColor, borderColor: colors.border },
                    settings.theme === t.key && { borderColor: colors.primary }]}
                  onPress={() => onUpdate({ theme: t.key })}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.label} theme`}
                  accessibilityState={{ selected: settings.theme === t.key }}
                >
                  <View style={[styles.themeCircle, { backgroundColor: themeStyles[t.key].backgroundColor, borderColor: themeStyles[t.key].textColor + '40' }]} />
                  <Text style={[styles.themeLabel, { color: themeStyles[t.key].textColor }]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Font Family */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>FONT</Text>
            <View style={styles.row}>
              {fontOptions.map(f => (
                <TouchableOpacity
                  key={f.key}
                  style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border },
                    settings.fontFamily === f.key && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => onUpdate({ fontFamily: f.key })}
                  accessibilityRole="button"
                  accessibilityLabel={`${f.label} font`}
                  accessibilityState={{ selected: settings.fontFamily === f.key }}
                >
                  <Text style={[styles.chipText, { color: colors.text },
                    settings.fontFamily === f.key && { color: '#fff' }]}>{f.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* TTS Speed */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>TTS SPEED</Text>
            <View style={styles.row}>
              {ttsSpeeds.map(s => (
                <TouchableOpacity
                  key={s}
                  style={[styles.chipSmall, { backgroundColor: colors.surface, borderColor: colors.border },
                    settings.ttsSpeed === s && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => onUpdate({ ttsSpeed: s })}
                  accessibilityRole="button"
                  accessibilityLabel={`TTS speed ${s}x`}
                  accessibilityState={{ selected: settings.ttsSpeed === s }}
                >
                  <Text style={[styles.chipText, { color: colors.text },
                    settings.ttsSpeed === s && { color: '#fff' }]}>{s}x</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Auto-save vocabulary (was "Instant Dictionary" — dictionary
                lookup removed from mobile 2026-05-15, only auto-save behavior
                remains. `autoLookup` field name kept for persisted-settings
                back-compat). */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>VOCABULARY</Text>
            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: colors.text }]}>Auto-save words on tap</Text>
              <Switch
                value={settings.autoLookup}
                onValueChange={v => onUpdate({ autoLookup: v })}
                trackColor={{ true: colors.primary, false: colors.border }}
                thumbColor="#fff"
                ios_backgroundColor={colors.border}
              />
            </View>

            {/* "Say the word on a card" moved to the vocabulary settings sheet. It controls the
                review screen, and this drawer belongs to the reader — QA said plainly that people
                would look for it where the cards are, and they were right. */}

            {/* Inline Translations */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>INLINE TRANSLATIONS</Text>
            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: colors.text }]}>Show translations for saved words</Text>
              <Switch
                value={settings.showInlineTranslations}
                onValueChange={v => onUpdate({ showInlineTranslations: v })}
                trackColor={{ true: colors.primary, false: colors.border }}
                thumbColor="#fff"
                ios_backgroundColor={colors.border}
              />
            </View>

            {/* Reading Stats */}
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>READING STATS</Text>
            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: colors.text }]}>Session time, daily goal, time left in chapter</Text>
              <Switch
                value={settings.showReaderStats}
                onValueChange={v => onUpdate({ showReaderStats: v })}
                trackColor={{ true: colors.primary, false: colors.border }}
                thumbColor="#fff"
                ios_backgroundColor={colors.border}
              />
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
  sizeButton: { width: 44, height: 44, borderRadius: 10, justifyContent: 'center', alignItems: 'center', borderWidth: 1 },
  sizeText: { fontFamily: fonts.sansBold, fontSize: 16 },
  sizePreview: { flex: 1, alignItems: 'center' },
  sizeValue: { fontFamily: fonts.sansMedium, fontSize: 16 },
  chip: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1 },
  chipSmall: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', borderWidth: 1 },
  chipText: { fontFamily: fonts.sansMedium, fontSize: 14 },
  themeChip: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 2, gap: 4 },
  themeCircle: { width: 20, height: 20, borderRadius: 10, borderWidth: 1 },
  themeLabel: { fontFamily: fonts.sansMedium, fontSize: 12 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  toggleLabel: { fontFamily: fonts.sans, fontSize: 14, flex: 1, marginRight: 12 },
})
