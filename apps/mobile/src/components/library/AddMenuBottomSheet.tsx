import { useEffect, useRef } from 'react'
import { Animated, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'

interface Props {
  visible: boolean
  onClose: () => void
  onUpload: () => void
}

interface Item {
  key: string
  icon: keyof typeof Ionicons.glyphMap
  labelKey: string
  onPress?: () => void
}

const SHEET_MAX_HEIGHT = 420

export function AddMenuBottomSheet({ visible, onClose, onUpload }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const slide = useRef(new Animated.Value(SHEET_MAX_HEIGHT)).current

  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 0 : SHEET_MAX_HEIGHT,
      duration: 220,
      useNativeDriver: true,
    }).start()
  }, [visible, slide])

  const handle = (cb?: () => void) => () => {
    onClose()
    cb?.()
  }

  // Only what works.
  //
  // This menu had five items and two of them were labelled COMING IN A FUTURE
  // UPDATE, taking exactly as much room as the one that opens a file picker. QA
  // filed that. A third was worse: "Browser extension" looked like a working
  // item and opened the Chrome Web Store HOME PAGE, because the extension lives
  // in apps/browser-extension/ at 0.1.0 and its own README says publishing it is an
  // unfinished owner-only step. A link to a store with nothing to find is not a
  // feature preview, it is a dead end wearing a working item's clothes.
  //
  // Restore each of them on the day it does something: paste-a-URL and
  // email-a-book when the endpoints exist, the extension when the listing does.
  const items: Array<Item | { divider: true; key: string }> = [
    { key: 'upload', icon: 'cloud-upload-outline', labelKey: 'addMenu.uploadFile', onPress: onUpload },
  ]

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.background,
            transform: [{ translateY: slide }],
            borderTopColor: colors.border,
          },
        ]}
      >
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: colors.text }]}>{t('addMenu.title')}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        {items.map((entry) => {
          if ('divider' in entry) {
            return <View key={entry.key} style={[styles.divider, { backgroundColor: colors.border }]} />
          }
          return (
            <TouchableOpacity
              key={entry.key}
              style={styles.item}
              onPress={handle(entry.onPress)}
              activeOpacity={0.7}
              accessibilityRole="menuitem"
            >
              <Ionicons name={entry.icon} size={22} color={colors.text} />
              <Text style={[styles.label, { color: colors.text }]}>{t(entry.labelKey)}</Text>
            </TouchableOpacity>
          )
        })}
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    paddingBottom: 32,
    paddingTop: 8,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.18)',
    marginBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  title: { fontFamily: fonts.sansBold, fontSize: 16 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  label: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 },
  divider: { height: 1, marginVertical: 4, marginHorizontal: 18 },
})
