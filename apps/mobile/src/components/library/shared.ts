/**
 * Shared surface between `LibraryScreen` and the two list bodies it renders.
 *
 * `SavedList` and `UploadsList` used to live inside `app/(tabs)/library.tsx`,
 * which had grown to 970 lines. They were lifted out verbatim; the styles they
 * share with the screen live here so the move stayed a pure relocation.
 */

import { StyleSheet } from 'react-native'
import { fonts } from '../../theme/typography'
import type { LibrarySortKey } from '../../hooks/useLibrarySort'

export type ViewMode = 'list' | 'grid'

export const SORT_KEYS: LibrarySortKey[] = ['recent', 'added', 'title', 'author', 'progress']

export const styles = StyleSheet.create({
  // The one row of browsing controls: status filters on the left, everything
  // else behind the options button on the right.
  controlRow: { flexDirection: 'row', alignItems: 'center' },
  viewBtn: { paddingHorizontal: 12, paddingVertical: 10 },
  // Small, and on the control that opens the sheet — the reader needs to know a
  // filter is on, not what it is; the sheet answers that.
  filterDot: {
    position: 'absolute',
    top: 6,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
  },
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, gap: 8 },
  emptyTitle: { fontFamily: fonts.serifBold, fontSize: 22, marginTop: 8 },
  emptyText: { fontFamily: fonts.sans, fontSize: 15, textAlign: 'center' },
  emptySubtext: { fontFamily: fonts.sans, fontSize: 13, textAlign: 'center' },
  browseButton: { marginTop: 12, paddingVertical: 12, paddingHorizontal: 32, borderRadius: 10 },
  browseButtonText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 15 },
  signInBtn: { marginTop: 12, paddingVertical: 12, paddingHorizontal: 32, borderRadius: 10 },
  signInText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 15 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabText: { fontFamily: fonts.sansMedium, fontSize: 14 },
  listContent: { paddingBottom: 20 },
  skeletonList: { padding: 12 },
  bookRow: { flexDirection: 'row', padding: 14, borderBottomWidth: 1 },
  coverWrapper: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  cover: { width: 70, height: 105, borderRadius: 6 },
  processingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bookInfo: { flex: 1, marginLeft: 14, justifyContent: 'center' },
  bookTitle: { fontFamily: fonts.sansMedium, fontSize: 15 },
  bookAuthor: { fontFamily: fonts.sans, fontSize: 13, marginTop: 2 },
  chapterCount: { fontFamily: fonts.sans, fontSize: 12, marginTop: 6 },
  progressRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  progressTrack: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
  progressText: { fontFamily: fonts.sans, fontSize: 11, width: 32 },
  continueBtn: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  continueBtnText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 13 },
  uploadBtn: {
    margin: 14,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  uploadBtnText: { fontFamily: fonts.sansMedium, fontSize: 15 },
  statusBadge: { fontFamily: fonts.sans, fontSize: 12, marginTop: 6 },
  quotaRow: { paddingHorizontal: 14, marginBottom: 8, alignItems: 'center', gap: 4 },
  quotaTrack: { height: 4, borderRadius: 2, overflow: 'hidden', width: '100%' },
  quotaFill: { height: '100%', borderRadius: 2 },
  savedSortRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingVertical: 10 },
  savedSortChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14 },
  // Where the filter tabs' count chips went. One line has room; four chips on a
  // phone's width did not.
  resultCount: { fontFamily: fonts.sans, fontSize: 12, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 2 },
  filterEmpty: { padding: 32, alignItems: 'center', gap: 12 },
  filterEmptyBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  // Grid styles
  gridContent: { paddingHorizontal: 10, paddingTop: 10, paddingBottom: 20 },
  gridCover: { width: '100%', aspectRatio: 2 / 3, borderRadius: 8 },
  gridTitle: { fontFamily: fonts.sansMedium, fontSize: 12, marginTop: 4 },
  gridBadge: {
    position: 'absolute', top: 4, left: 4, width: 18, height: 18, borderRadius: 9,
    justifyContent: 'center', alignItems: 'center',
  },
  gridPillSlot: { position: 'absolute', top: 4, left: 4 },
  listPillSlot: { position: 'absolute', top: 4, left: 4 },
  gridProgressTrack: { height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 4 },
  gridProgressFill: { height: '100%', borderRadius: 2 },
  gridDotsBtn: {
    position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  rowDotsBtn: {
    paddingHorizontal: 10, alignSelf: 'center', justifyContent: 'center',
  },
  sidebarHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingTop: 8,
  },
  menuBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, paddingHorizontal: 10,
  },
  menuBtnText: { fontFamily: fonts.sansMedium, fontSize: 13 },
})

