import { useEffect, useState } from 'react'
import { View, Text, FlatList, TouchableOpacity, RefreshControl, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getStorageUrl,
  entryKey, entryTitle, entryAuthor, entryCoverPath, entryProgress, resumeChapterSlug,
  type LibraryEntry, type UserLibraryItem, type ReadingProgressDto, formatTimeAgo, userBooksApi } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useToast } from '../../context/ToastContext'
import { fonts } from '../../theme/typography'
import { AddToCollectionSheet } from './AddToCollectionSheet'
import { useSheetMount } from '../../hooks/useSheetMount'
import { BookStatusBadge } from './BookStatusBadge'
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
}

export function BookList({
  entries, progressMap, library, setLibrary, setProgressMap,
  refreshing, onRefresh, viewMode, listHeader,
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
  const numColumns = viewMode === 'grid' ? Math.max(2, Math.floor(width / 130)) : 1

  const { showSavedActions, showUploadActions } = useBookActions()
  // Where each book actually is. The library downloads itself now, and until
  // this arrived nothing on the shelf admitted it — the reader could not tell
  // what was on the phone from what still needed a connection.
  const { downloads, cachedUserBooks, startUserBookDownload } = useDownload()

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

  /** The row's own answer, and the tap that changes it. Uploads only: a
   *  catalogue edition's download needs a payload this list does not carry, and
   *  inventing a second path to it here would be the duplication this slice is
   *  meant to remove. */
  const offlineFor = (e: LibraryEntry) => {
    if (e.kind !== 'upload') return null
    const id = e.book.id
    const dl = downloads.get(id)
    const meta = cachedUserBooks.find(b => b.bookId === id)
    const state = offlineStateFor({
      download: dl ? { status: dl.status, downloadedChapters: dl.downloadedChapters, totalChapters: dl.totalChapters } : null,
      cached: meta ? { cachedChapters: meta.cachedChapters, totalChapters: meta.totalChapters } : null,
      needsOriginal: meta?.isPdf === true,
      hasOriginal: storedOriginals.has(id),
    })
    const ready = e.book.status.toLowerCase() === 'ready'
    return {
      state,
      percent: dl ? downloadPercent(dl) : null,
      onDownload: ready && (state === 'in-cloud' || state === 'partial')
        ? async () => {
            try {
              const detail = await userBooksApi.getUserBook(id)
              await startUserBookDownload(detail)
            } catch {
              showToast({ message: "Couldn't start the download. Try again.", variant: 'error' })
            }
          }
        : undefined,
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
    // `serverProgress.chapterSlug` is derived server-side from the row's `chapterId`, and that id
    // stops moving once infinite scroll carries the reader past the chapter they opened. Following
    // it sent a reader 45% in back to the top of chapter two. The locator is the position.
    const continueSlug = e.kind === 'saved'
      ? resumeChapterSlug(serverProgress?.chapterSlug, serverProgress?.locator, null)
      : null
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

            {lastRead && !isFailed && (
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary, marginTop: 4 }}>
                {t('library.lastRead')} {formatTimeAgo(lastRead)}
              </Text>
            )}

            {/* Where the book is, and the tap that changes it — on the shelf,
                not three taps inside the book. The original objection to the
                old design was exactly that you had to go in to find this. */}
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

            {continueSlug ? (
              <TouchableOpacity
                style={[styles.continueBtn, { backgroundColor: colors.primary }]}
                onPress={() => router.push(`/reader/${(e as { item: UserLibraryItem }).item.slug}/${continueSlug}`)}
              >
                <Ionicons name="play" size={12} color="#fff" />
                {/* "Continue" promises to put the reader back where they stopped.
                    A book at 0% has a chapterSlug the moment the reader opens it
                    and scrolls nothing, so the promise was made with nowhere to
                    return to. `library.resume.start` has existed in en.json since
                    the beginning, unused — the switch was intended and never
                    wired. */}
                <Text style={styles.continueBtnText}>
                  {pct > 0 ? t('library.resume.continue') : t('library.resume.start')}
                </Text>
              </TouchableOpacity>
            ) : null}
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
