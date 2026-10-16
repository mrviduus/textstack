import { useMemo, useState } from 'react'
import { View, FlatList, RefreshControl, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  entryKey,
  type LibraryEntry, type UserLibraryItem, type ContinueReadingPick, type ReadingProgressDto } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useToast } from '../../context/ToastContext'
import { AddToCollectionSheet } from './AddToCollectionSheet'
import { useSheetMount } from '../../hooks/useSheetMount'
import { useBookOffline } from '../../hooks/useBookOffline'
import { BookGridCell } from './BookGridCell'
import { BookListRow } from './BookListRow'
import { useResume } from './ResumeButton'
import { bookRowModel } from '../../lib/bookRow'
import { continuePickFor, firstContinuePick, keyOfPick } from '../../lib/continueRow'
import { useBookActions } from '../../hooks/useBookActions'
import { styles, type ViewMode } from './shared'

/**
 * The reader's books — all of them, in one list.
 *
 * There used to be two lists behind two tabs, "Saved" and "Uploads", which are
 * table names. They shared roughly 85% of their markup and drifted anyway. A
 * book's storage shape now only decides what a row can show (an upload can be
 * mid-parse; a catalog edition cannot), never which list it lives in.
 *
 * Filtering, sorting and search happen on the screen above; this renders what
 * it is given.
 */

interface Props {
  /** Already filtered by source/status/search and sorted by the screen. */
  entries: LibraryEntry[]
  progressMap: Record<string, ReadingProgressDto>
  library: UserLibraryItem[]
  setLibrary: React.Dispatch<React.SetStateAction<UserLibraryItem[]>>
  setProgressMap: React.Dispatch<React.SetStateAction<Record<string, ReadingProgressDto>>>
  refreshing: boolean
  onRefresh: () => void
  viewMode: ViewMode
  listHeader: React.ReactNode
  /** In-progress books, most recent first. [0] gets the filled Continue; the rest are outlines. */
  resumeList: ContinueReadingPick[]
}

export function BookList({
  entries, progressMap, library, setLibrary, setProgressMap,
  refreshing, onRefresh, viewMode, listHeader, resumeList,
}: Props) {
  const router = useRouter()
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { show: showToast } = useToast()
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
  const { open: resume, busyKey } = useResume()
  const numColumns = viewMode === 'grid' ? Math.max(2, Math.floor(width / 130)) : 1

  const { showSavedActions, showUploadActions } = useBookActions()
  const offlineFor = useBookOffline()
  const [collectionTarget, setCollectionTarget] = useState<LibraryEntry | null>(null)
  // Same reason as everywhere else this sheet appears — see useSheetMount.
  const collectionSheetMounted = useSheetMount(!!collectionTarget)

  const handleAction = (e: LibraryEntry) => {
    if (e.kind === 'saved') {
      showSavedActions(e.item, {
        progressMap, setLibrary, setProgressMap, library,
        onAddToCollection: () => setCollectionTarget(e),
      })
      return
    }
    showUploadActions(e.book, {
      onChange: onRefresh,
      openDetails: (id) => router.push(`/my-books/${id}`),
      onAddToCollection: () => setCollectionTarget(e),
    })
  }

  /** Where tapping the row goes. An upload still parsing has nothing to open. */
  const openEntry = (e: LibraryEntry) => {
    if (e.kind === 'saved') { router.push(`/book/${e.item.slug}`); return }
    const s = e.book.status.toLowerCase()
    if (s === 'ready' || s === 'completed') router.push(`/my-books/${e.book.id}`)
  }

  const cardWidth = (width - 20 - (numColumns - 1) * 10) / numColumns

  const renderEntry = (e: LibraryEntry) => {
    const model = bookRowModel(e, progressMap)
    const pick = continuePickFor(e, picks)
    const common = {
      model, pick, isTop: pick != null && pick === top, busyKey,
      onOpen: () => openEntry(e), onMenu: () => handleAction(e), onResume: resume,
    }
    return viewMode === 'grid'
      ? <BookGridCell {...common} cardWidth={cardWidth} />
      : <BookListRow {...common} offline={offlineFor(e)} />
  }

  const targetId = collectionTarget
    ? (collectionTarget.kind === 'saved' ? collectionTarget.item.editionId : collectionTarget.book.id)
    : null

  return (
    <>
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
      {collectionSheetMounted && <AddToCollectionSheet
        visible={!!collectionTarget}
        bookId={targetId}
        bookType={collectionTarget?.kind === 'upload' ? 'userbook' : 'savedbook'}
        onClose={() => setCollectionTarget(null)}
        onAdded={(name) => showToast({ message: t('library.actions.addedToCollection').replace('{{name}}', name), variant: 'success' })}
      />}
    </>
  )
}
