import { useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, TouchableOpacity, RefreshControl, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getStorageUrl,
  entryKey, entryTitle, entryAuthor, entryCoverPath, entryProgress,
  type LibraryEntry, type UserLibraryItem, type ContinueReadingPick, type ReadingProgressDto, formatTimeAgo, userBooksApi, createBooksApi } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useToast } from '../../context/ToastContext'
import { fonts } from '../../theme/typography'
import { AddToCollectionSheet } from './AddToCollectionSheet'
import { useSheetMount } from '../../hooks/useSheetMount'
import { BookStatusBadge } from './BookStatusBadge'
import { ResumeButton } from './ResumeButton'
import { GeneratedCover } from './GeneratedCover'
import { useBookActions } from '../../hooks/useBookActions'
import { styles, type ViewMode } from './shared'
import { useDownload } from '../../context/DownloadContext'
import { OfflineStateBadge } from './OfflineStateBadge'
import { downloadPercent, offlineStateFor } from '../../lib/offlineState'
import { listStoredOriginalIds } from '../../lib/originalFileCache'

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

const NEW_BADGE_TTL_MS = 24 * 60 * 60 * 1000

function isNewUpload(createdAt?: string): boolean {
  if (!createdAt) return false
  const ts = Date.parse(createdAt)
  if (Number.isNaN(ts)) return false
  return Date.now() - ts < NEW_BADGE_TTL_MS
}

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
    () => new Map(resumeList.map(p => [p.type === 'userbook' ? `u:${p.id}` : `s:${p.slug}`, p] as const)),
    [resumeList],
  )
  const top = resumeList[0]
  const numColumns = viewMode === 'grid' ? Math.max(2, Math.floor(width / 130)) : 1

  const { showSavedActions, showUploadActions } = useBookActions()
  // Where each book actually is. The library downloads itself now, and until
  // this arrived nothing on the shelf admitted it — the reader could not tell
  // what was on the phone from what still needed a connection.
  const { downloads, cachedBooks, cachedUserBooks, startDownload, startUserBookDownload } = useDownload()

  // Which uploads have their original file here. One directory listing for the
  // whole shelf, refreshed when the cache set changes — asking per row would be
  // a filesystem probe per row, and guessing from `isPdf` would be reasoning in
  // a circle: that flag says the book HAS an original, never that we hold it.
  const [storedOriginals, setStoredOriginals] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    listStoredOriginalIds()
      .then(ids => { if (!cancelled) setStoredOriginals(ids) })
      .catch(() => { /* an unreadable directory just means no badge upgrade */ })
    return () => { cancelled = true }
  }, [cachedUserBooks])

  /**
   * The row's own answer, and the tap that changes it — for both halves of the
   * shelf.
   *
   * The two differ in exactly one place: which payload the download needs and
   * where it comes from. Everything else — the state, the percentage, the rule
   * about when a tap is offered — is shared, because a reader looking at a
   * shelf should not be able to tell which half of it they are looking at.
   *
   * The catalogue is fetched on tap rather than held for every row: a list of
   * a hundred editions would otherwise make a hundred detail requests to
   * answer a question only the tapped row asks.
   */
  const offlineFor = (e: LibraryEntry) => {
    const id = e.kind === 'upload' ? e.book.id : e.item.editionId
    const dl = downloads.get(id)
    const meta = e.kind === 'upload'
      ? cachedUserBooks.find(b => b.bookId === id)
      : cachedBooks.find(b => b.editionId === id)
    const isPdfUpload = e.kind === 'upload' && (meta as { isPdf?: boolean } | undefined)?.isPdf === true

    const state = offlineStateFor({
      download: dl ? { status: dl.status, downloadedChapters: dl.downloadedChapters, totalChapters: dl.totalChapters } : null,
      cached: meta ? { cachedChapters: meta.cachedChapters, totalChapters: meta.totalChapters } : null,
      needsOriginal: isPdfUpload,
      hasOriginal: storedOriginals.has(id),
    })

    // A catalogue edition is always downloadable; an upload has to have
    // finished processing first.
    const downloadable = e.kind === 'saved' || e.book.status.toLowerCase() === 'ready'

    const start = async () => {
      try {
        if (e.kind === 'upload') {
          await startUserBookDownload(await userBooksApi.getUserBook(id))
        } else {
          const api = createBooksApi(e.item.language)
          await startDownload(await api.getBook(e.item.slug), e.item.language)
        }
      } catch {
        showToast({ message: "Couldn't start the download. Try again.", variant: 'error' })
      }
    }

    return {
      state,
      percent: dl ? downloadPercent(dl) : null,
      onDownload: downloadable && (state === 'in-cloud' || state === 'partial') ? start : undefined,
    }
  }
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

  const renderEntry = (e: LibraryEntry) => {
    const title = entryTitle(e) || 'Untitled'
    const author = entryAuthor(e)
    const cover = entryCoverPath(e)
    const pct = Math.round(entryProgress(e, progressMap) * 100)

    const status = e.kind === 'upload' ? e.book.status.toLowerCase() : 'ready'
    const isReady = status === 'ready' || status === 'completed'
    const isProcessing = e.kind === 'upload' && !isReady && status !== 'failed'
    const isFailed = status === 'failed'
    const finishedAt = e.kind === 'upload' ? e.book.completedAt : null
    const isFinished = e.kind === 'upload' ? (finishedAt != null || pct >= 100) : pct >= 100
    const showNew = e.kind === 'upload' && isReady && !finishedAt && isNewUpload(e.book.createdAt)
    const dimmed = !isReady

    // One badge system: the pill over the cover states what is wrong or new.
    // A second, differently-styled status line used to sit in the text column
    // saying the same words.
    const pill = isProcessing ? 'processing' : isFailed ? 'failed' : showNew ? 'new' : null

    const pick = picks.get(e.kind === 'saved' ? `s:${e.item.slug}` : `u:${e.book.id}`)
    const canContinue = pick && !isFinished && (e.kind === 'saved' || isReady)

    if (viewMode === 'grid') {
      const cardWidth = (width - 20 - (numColumns - 1) * 10) / numColumns
      return (
        <View style={{ width: cardWidth, marginBottom: 14, position: 'relative' }}>
          <TouchableOpacity onPress={() => openEntry(e)} onLongPress={() => handleAction(e)} activeOpacity={0.85}>
            <View>
              {cover ? (
                <Image source={getStorageUrl(cover)} style={styles.gridCover} contentFit="cover" />
              ) : (
                <GeneratedCover title={title} author={author} style={styles.gridCover} />
              )}
              {isFinished && (
                <View style={[styles.gridBadge, { backgroundColor: colors.success }]}>
                  <Ionicons name="checkmark" size={10} color="#fff" />
                </View>
              )}
              {pill && (
                <View style={styles.gridPillSlot}>
                  <BookStatusBadge variant={pill} />
                </View>
              )}
              {canContinue && (
                <View style={{ position: 'absolute', right: 6, bottom: 6 }}>
                  <ResumeButton pick={pick} filled={pick === top} compact />
                </View>
              )}
            </View>
            {pct > 0 && pct < 100 && (
              <View style={[styles.gridProgressTrack, { backgroundColor: colors.border }]}>
                <View style={[styles.gridProgressFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
              </View>
            )}
            <Text style={[styles.gridTitle, { color: dimmed ? colors.textSecondary : colors.text }]} numberOfLines={2}>
              {title}
            </Text>
            {!!author && (
              <Text style={[styles.bookAuthor, { color: colors.textSecondary }]} numberOfLines={1}>{author}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.gridDotsBtn, { backgroundColor: 'rgba(0,0,0,0.45)' }]}
            onPress={() => handleAction(e)}
            hitSlop={8}
            accessibilityLabel={t('library.actions.menu')}
          >
            <Ionicons name="ellipsis-vertical" size={14} color="#fff" />
          </TouchableOpacity>
        </View>
      )
    }

    const serverProgress = e.kind === 'saved' ? progressMap[e.item.editionId] : undefined
    const continuePill = canContinue ? <ResumeButton pick={pick} filled={pick === top} /> : null
    const lastRead = e.kind === 'saved' ? serverProgress?.updatedAt : e.book.progressUpdatedAt

    return (
      <View style={[styles.bookRow, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={{ flexDirection: 'row', flex: 1 }}
          onPress={() => openEntry(e)}
          onLongPress={() => handleAction(e)}
          activeOpacity={0.85}
        >
          <View style={styles.coverWrapper}>
            {cover ? (
              <Image source={getStorageUrl(cover)} style={styles.cover} contentFit="cover" />
            ) : (
              <GeneratedCover title={title} author={author} style={styles.cover} />
            )}
            {pill && (
              <View style={styles.listPillSlot}>
                <BookStatusBadge variant={pill} />
              </View>
            )}
          </View>

          <View style={styles.bookInfo}>
            <Text style={[styles.bookTitle, { color: dimmed ? colors.textSecondary : colors.text }]} numberOfLines={2}>
              {title}
            </Text>
            {!!author && (
              <Text style={[styles.bookAuthor, { color: colors.textSecondary }]} numberOfLines={1}>{author}</Text>
            )}

            {isFinished ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                <Text style={{ fontSize: 12, color: colors.success, fontFamily: fonts.sansMedium }}>
                  {t('library.filter.finished')}
                </Text>
              </View>
            ) : pct > 0 ? (
              <View style={styles.progressRow}>
                <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                  <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
                </View>
                <Text style={[styles.progressText, { color: colors.textSecondary }]}>{pct}%</Text>
              </View>
            ) : null}

            {isFailed && e.kind === 'upload' && e.book.errorMessage && (
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.error, marginTop: 4 }} numberOfLines={2}>
                {e.book.errorMessage}
              </Text>
            )}

            {((lastRead && !isFailed) || continuePill) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: lastRead && !isFailed ? 'space-between' : 'flex-end', marginTop: 4 }}>
                {lastRead && !isFailed && (
                  <Text numberOfLines={1} style={{ flexShrink: 1, marginRight: 8, fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary }}>
                    {`${t('library.lastRead')} ${formatTimeAgo(lastRead)}`}
                  </Text>
                )}
                {continuePill}
              </View>
            )}

            {/* Where the book is, and the tap that changes it — on the shelf,
                not three taps inside the book. The original objection to the
                old design was exactly that you had to go in to find this.
                Both halves of the shelf: a reader should not be able to tell
                which one they are looking at. */}
            {(() => {
              const offline = offlineFor(e)
              if (!offline || isFailed) return null
              return (
                <OfflineStateBadge
                  state={offline.state}
                  percent={offline.percent}
                  onDownload={offline.onDownload}
                />
              )
            })()}

          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.rowDotsBtn}
          onPress={() => handleAction(e)}
          hitSlop={10}
          accessibilityLabel={t('library.actions.menu')}
        >
          <Ionicons name="ellipsis-vertical" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    )
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
