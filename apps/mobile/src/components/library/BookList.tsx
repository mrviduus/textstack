import { useMemo } from 'react'
import { View, FlatList, RefreshControl, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  entryKey,
  type LibraryEntry, type ContinueReadingPick, type ReadingProgressDto } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useBookOffline } from '../../hooks/useBookOffline'
import { BookGridCell } from './BookGridCell'
import { BookListRow } from './BookListRow'
import { useResume } from './ResumeButton'
import { bookRowModel } from '../../lib/bookRow'
import { continuePickFor, firstContinuePick, keyOfPick } from '../../lib/continueRow'
import { useBookActions } from '../../hooks/useBookActions'
import { styles, type ViewMode } from './shared'

/**
 * The reader's books (uploads; the catalog shelf retired at M6), in one list.
 *
 * Filtering, sorting and search happen on the screen above; this renders what
 * it is given.
 */

/** Catalog progress, keyed by edition: none since the catalog retired (an upload carries its own). */
const NO_PROGRESS: Record<string, ReadingProgressDto> = {}

interface Props {
  /** Already filtered by source/status/search and sorted by the screen. */
  entries: LibraryEntry[]
  refreshing: boolean
  onRefresh: () => void
  viewMode: ViewMode
  listHeader: React.ReactNode
  /** In-progress books, most recent first. [0] gets the filled Continue; the rest are outlines. */
  resumeList: ContinueReadingPick[]
}

export function BookList({
  entries,
  refreshing, onRefresh, viewMode, listHeader, resumeList,
}: Props) {
  const router = useRouter()
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  // Clear the floating tab bar (~56 + bottom inset) so the last row isn't
  // hidden behind it or the raised "+" button.
  const bottomPad = 56 + insets.bottom + 24
  // One pick per book, keyed like the rows. Local-aware (rankContinueReading), so a book read
  // offline resumes where it was left, not at the stale server position.
  const picks = useMemo(
    () => new Map(resumeList.map(p => [keyOfPick(p), p] as const)),
    [resumeList],
  )
  const top = useMemo(() => firstContinuePick(entries, picks), [entries, picks])
  const resume = useResume()
  const numColumns = viewMode === 'grid' ? Math.max(2, Math.floor(width / 130)) : 1

  const { showUploadActions } = useBookActions()
  const offlineFor = useBookOffline()

  const handleAction = (e: LibraryEntry) => {
    if (e.kind !== 'upload') return
    showUploadActions(e.book, {
      onChange: onRefresh,
      openDetails: (id) => router.push(`/my-books/${id}`),
    })
  }

  /** Where tapping the row goes. An upload still parsing has nothing to open. */
  const openEntry = (e: LibraryEntry) => {
    if (e.kind === 'upload' && bookRowModel(e, NO_PROGRESS).isReady) router.push(`/my-books/${e.book.id}`)
  }

  const cardWidth = (width - 20 - (numColumns - 1) * 10) / numColumns

  const renderEntry = (e: LibraryEntry) => {
    const model = bookRowModel(e, NO_PROGRESS)
    const pick = continuePickFor(e, picks)
    const common = {
      model, pick, isTop: pick != null && pick === top,
      onOpen: () => openEntry(e), onMenu: () => handleAction(e), onResume: resume,
    }
    return viewMode === 'grid'
      ? <BookGridCell {...common} cardWidth={cardWidth} />
      : <BookListRow {...common} offline={offlineFor(e)} />
  }

  return (
    <FlatList
      key={viewMode}
      data={entries}
      numColumns={numColumns}
      keyExtractor={entryKey}
      ListHeaderComponent={<View>{listHeader}</View>}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      contentContainerStyle={[viewMode === 'grid' ? styles.gridContent : styles.listContent, { paddingBottom: bottomPad }]}
      columnWrapperStyle={viewMode === 'grid' ? { gap: 10 } : undefined}
      renderItem={({ item }) => renderEntry(item)}
    />
  )
}
