import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { collectionsApi, type CollectionBookType } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { useCollections, invalidateCollectionsCache } from '../../hooks/useCollections'

interface Props {
  visible: boolean
  bookId: string | null
  bookType: CollectionBookType
  onClose: () => void
  onAdded?: (collectionName: string) => void
}

export function AddToCollectionSheet({ visible, bookId, bookType, onClose, onAdded }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { collections, refresh, create } = useCollections()
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // Parent can flip `visible` to false from anywhere (route change, focus
  // loss, programmatic dismiss). handleClose runs reset() only when *we*
  // close the sheet — those external flips would leave stale create-mode
  // state for the next open. Mirror the web popover's effect-based reset.
  useEffect(() => {
    if (!visible) {
      setBusy(false)
      setCreating(false)
      setNewName('')
    }
  }, [visible])

  const handleClose = () => {
    onClose()
  }

  const handlePick = async (collectionId: string, name: string) => {
    if (!bookId || busy) return
    setBusy(true)
    try {
      await collectionsApi.addBookToCollection(collectionId, bookId, bookType)
      invalidateCollectionsCache()
      await refresh()
      onAdded?.(name)
      handleClose()
    } catch (e) {
      Alert.alert(t('library.actions.addToCollectionFailed'), e instanceof Error ? e.message : '')
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    const trimmed = newName.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const c = await create(trimmed)
      if (bookId) {
        await collectionsApi.addBookToCollection(c.id, bookId, bookType)
        invalidateCollectionsCache()
        await refresh()
        onAdded?.(c.name)
      }
      handleClose()
    } catch (e) {
      Alert.alert(t('library.actions.addToCollectionFailed'), e instanceof Error ? e.message : '')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{t('library.actions.addToCollection')}</Text>
          <TouchableOpacity onPress={handleClose} hitSlop={10}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {creating ? (
          <View style={styles.createRow}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={t('library.collections.newPlaceholder')}
              placeholderTextColor={colors.textSecondary}
              style={[styles.input, { color: colors.text, borderColor: colors.border }]}
              autoFocus
              onSubmitEditing={handleCreate}
              returnKeyType="done"
              maxLength={50}
            />
            <TouchableOpacity
              style={[styles.createBtn, { backgroundColor: colors.primary, opacity: newName.trim() && !busy ? 1 : 0.5 }]}
              onPress={handleCreate}
              disabled={!newName.trim() || busy}
            >
              <Text style={[styles.createBtnLabel, { color: '#fff' }]}>{t('library.collections.add')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 24 }}>
            {collections.length === 0 ? (
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {t('library.actions.addToCollectionEmpty')}
              </Text>
            ) : (
              collections.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.option, { borderBottomColor: colors.border }]}
                  disabled={busy}
                  onPress={() => handlePick(c.id, c.name)}
                >
                  <Ionicons name="folder-outline" size={18} color={colors.textSecondary} />
                  <Text style={[styles.optionLabel, { color: colors.text }]} numberOfLines={1}>{c.name}</Text>
                  <Text style={[styles.optionCount, { color: colors.textSecondary }]}>{c.count}</Text>
                </TouchableOpacity>
              ))
            )}

            <TouchableOpacity
              style={[styles.option, styles.newRow, { borderColor: colors.border }]}
              onPress={() => setCreating(true)}
              disabled={busy}
            >
              <Ionicons name="add" size={18} color={colors.primary} />
              <Text style={[styles.optionLabel, { color: colors.primary, fontFamily: fonts.sansMedium }]}>
                {t('library.collections.new')}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 24,
    maxHeight: '80%',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.4)',
    marginTop: 8,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  title: { fontFamily: fonts.serifBold, fontSize: 18 },
  list: { paddingHorizontal: 20 },
  empty: {
    fontFamily: fonts.sans,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 20,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 },
  optionCount: { fontFamily: fonts.sans, fontSize: 13 },
  newRow: {
    borderBottomWidth: 0,
    marginTop: 8,
    paddingVertical: 14,
  },
  createRow: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.sans,
    fontSize: 15,
  },
  createBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  createBtnLabel: { fontFamily: fonts.sansMedium, fontSize: 14 },
})
