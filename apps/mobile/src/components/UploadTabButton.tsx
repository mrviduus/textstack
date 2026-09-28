import { useState } from 'react'
import { TouchableOpacity, View, StyleSheet, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useTheme } from '../context/ThemeContext'
import { AddMenuBottomSheet } from './library/AddMenuBottomSheet'

export function UploadTabButton() {
  const { colors } = useTheme()
  const router = useRouter()
  const [sheetOpen, setSheetOpen] = useState(false)

  const goUpload = () => router.push('/my-books/upload')

  // No session check here, and that is the whole point.
  //
  // This used to send an install with no session to `/(auth)/login`, on the
  // reasoning that there was "genuinely nowhere to put the file". That reasoning
  // died when `/my-books/upload` was wrapped in `SessionGate` (#628): the route
  // mints a guest on arrival, so the place to put the file is created by walking
  // through the door. The tab layout was fixed for exactly this on 2026-09-28 and
  // says so in as many words — "`canUpload` is the wrong question for a door" —
  // and then this handler went on asking it one level down. Found on a device:
  // a fresh install tapping "+" landed on Sign in, with no mint even attempted.
  //
  // `canUpload` is still the right question for anything that acts on the
  // server. It is not the question for opening a menu.
  const onPress = () => setSheetOpen(true)

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Upload"
        onPress={onPress}
        activeOpacity={0.85}
        style={styles.wrapper}
      >
        <View style={[styles.button, { backgroundColor: colors.primary, shadowColor: colors.text }]}>
          <Ionicons name="add" size={28} color="#fff" />
        </View>
      </TouchableOpacity>
      <AddMenuBottomSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onUpload={goUpload}
      />
    </>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    top: -18,
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
  },
  button: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
      },
      android: { elevation: 6 },
    }),
  },
})
