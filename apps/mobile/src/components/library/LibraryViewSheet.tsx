import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { useCollections } from '../../hooks/useCollections'
import type { LibrarySortKey } from '../../hooks/useLibrarySort'
import { SORT_KEYS, type ViewMode } from './shared'

export type LibrarySource = 'all' | 'uploads' | 'catalog'

/**
 * Every control that shapes the book list, behind one entry.
 *
 * These used to be laid out flat on the screen: a left drawer for source and
 * collections, a segment-tab row, a scrollable row of five sort chips, and a
 * pair of view icons — four separate rows of chrome the reader scrolled past
 * to reach their own books. Web has always kept the same choices in a single
 * toolbar with a sort *menu* (`apps/web/src/components/library/LibraryToolbar.tsx`);
 * mobile flattened what web collapsed.
 *
 * A bottom sheet rather than the old left drawer: it is thumb-reachable, and it
 * is opened from the control row on the right, so the sheet appears next to the
 * finger that asked for it.
 */

interface Props {
  visible: boolean
  source: LibrarySource
  counts: { all: number; uploads: number; catalog: number }
  sort: LibrarySortKey
  viewMode: ViewMode
  activeCollectionId: string | null
  onSelectSource: (next: LibrarySource) => void
  onSelectSort: (next: LibrarySortKey) => void
  onSelectViewMode: (next: ViewMode) => void
  onCollectionSelect: (id: string | null) => void
  onClose: () => void
}

function SectionHeading({ children }: { children: string }) {
  const { colors } = useTheme()
  return <Text style={[styles.heading, { color: colors.textSecondary }]}>{children.toUpperCase()}</Text>
}

/** One tappable row with an optional trailing count and a check when active. */
function Row({
  icon, label, count, active, onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  count?: number
  active: boolean
  onPress: () => void
}) {
  const { colors } = useTheme()
  return (
    <TouchableOpacity
      style={[styles.row, active && { backgroundColor: colors.primaryLight }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Ionicons name={icon} size={18} color={active ? colors.primary : colors.textSecondary} />
      <Text style={[styles.label, { color: active ? colors.primary : colors.text }]} numberOfLines={1}>
        {label}
      </Text>
      {count != null && (
        <Text style={[styles.count, { color: colors.textSecondary }]}>{count}</Text>
      )}
      {active && <Ionicons name="checkmark" size={18} color={colors.primary} />}
    </TouchableOpacity>
  )
}

export function LibraryViewSheet({
  visible, source, counts, sort, viewMode, activeCollectionId,
  onSelectSource, onSelectSort, onSelectViewMode, onCollectionSelect, onClose,
}: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { collections } = useCollections()

  const sources: Array<{ key: LibrarySource; icon: keyof typeof Ionicons.glyphMap; label: string; count: number }> = [
    { key: 'all', icon: 'book-outline', label: t('library.sidebar.all'), count: counts.all },
    { key: 'uploads', icon: 'cloud-upload-outline', label: t('library.sidebar.uploads'), count: counts.uploads },
    { key: 'catalog', icon: 'bookmark-outline', label: t('library.sidebar.catalog'), count: counts.catalog },
  ]

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('library.sidebar.close')} />
      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={[styles.grabber, { backgroundColor: colors.border }]} />
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{t('library.view.title')}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('library.view.done')}>
            <Text style={[styles.done, { color: colors.primary }]}>{t('library.view.done')}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
          <SectionHeading>{t('library.view.source')}</SectionHeading>
          {sources.map(s => (
            <Row
              key={s.key}
              icon={s.icon}
              label={s.label}
              count={s.count}
              active={source === s.key && !activeCollectionId}
              onPress={() => { onSelectSource(s.key); onCollectionSelect(null) }}
            />
          ))}

          <SectionHeading>{t('library.view.sort')}</SectionHeading>
          {SORT_KEYS.map(key => (
            <Row
              key={key}
              icon="swap-vertical-outline"
              label={t(`library.sort.${key}`)}
              active={sort === key}
              onPress={() => onSelectSort(key)}
            />
          ))}

          <SectionHeading>{t('library.view.layout')}</SectionHeading>
          <Row icon="list-outline" label={t('library.view.list')} active={viewMode === 'list'} onPress={() => onSelectViewMode('list')} />
          <Row icon="grid-outline" label={t('library.view.grid')} active={viewMode === 'grid'} onPress={() => onSelectViewMode('grid')} />

          {collections.length > 0 && (
            <>
              <SectionHeading>{t('library.sidebar.collections')}</SectionHeading>
              {collections.map(c => (
                <Row
                  key={c.id}
                  icon="folder-outline"
                  label={c.name}
                  count={c.count}
                  active={activeCollectionId === c.id}
                  onPress={() => onCollectionSelect(activeCollectionId === c.id ? null : c.id)}
                />
              ))}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    maxHeight: '80%',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 12, paddingTop: 10,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingBottom: 8,
  },
  title: { fontFamily: fonts.serifBold, fontSize: 20 },
  done: { fontFamily: fonts.sansMedium, fontSize: 15 },
  heading: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 0.6, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 8 },
  label: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 },
  count: { fontFamily: fonts.sans, fontSize: 13 },
})
