import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * ReaderPage was split by job (2026-10). A guard that used to read `ReaderPage.tsx` alone reads
 * the page plus every file its code moved to, so a line cannot dodge a guard by moving.
 * A new file split out of ReaderPage belongs in this list.
 */
export const READER_PAGE_FILES = [
  '../ReaderPage.tsx',
  '../../hooks/useReaderPdfOriginal.ts',
  '../../hooks/useReaderBookProgress.ts',
  '../../hooks/useReaderSessionTracking.ts',
  '../../hooks/useReaderPositionSync.ts',
  '../../hooks/useReaderDrawers.ts',
  '../../hooks/useReaderLibraryTracking.ts',
  '../../hooks/useReaderReviews.ts',
  '../../components/reader/ReaderOriginalPdf.tsx',
  '../../components/reader/ReaderReflowChapter.tsx',
  '../../components/reader/ReaderChapterDiscuss.tsx',
  '../../components/reader/ReaderDrawers.tsx',
  '../../components/reader/ReaderScreens.tsx',
  '../../components/reader/ReaderCompleteOverlay.tsx',
].map((f) => resolve(__dirname, f))

/** ReaderPage's code, all of it, as one string. */
export function readerPageSource(): string {
  return READER_PAGE_FILES.map((f) => readFileSync(f, 'utf8')).join('\n')
}
